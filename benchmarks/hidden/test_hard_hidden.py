"""Applied only during grading: checks every requirement across all 16 connectors & invariants."""
from __future__ import annotations

import importlib
import inspect
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pytest

from chronos.core.errors import IdempotencyConflictError, ValidationError
from chronos.engine.pipeline import IngestionPipeline, PipelineConfig
from chronos.engine.reconcile import reconcile_tenant
from chronos.core.models import EventEnvelope


def test_shared_normalize_helper_exists_and_enforces_contract():
    from chronos.core.normalize import normalize_event

    env = normalize_event(
        {
            "event_id": "n-1",
            "tenant": "acme",
            "seq_id": 3,
            "amount": "1,234.565",
            "currency": "eur",
            "occurred_at": "2026-11-01 12:00:00",
            "metadata": None,
        },
        default_tz_offset_hours=2,
    )
    assert isinstance(env, EventEnvelope)
    assert env.tenant_id == "acme"
    assert env.currency == "EUR"
    assert env.amount == Decimal("1234.56")  # ROUND_HALF_EVEN
    assert env.occurred_at == datetime(2026, 11, 1, 10, 0, tzinfo=timezone.utc)
    assert env.metadata == {}

    cents_env = normalize_event(
        {
            "event_id": "n-2",
            "tenant_id": "acme",
            "seq_id": 4,
            "amount_cents": 2505,
            "occurred_at": "2026-11-01T10:00:00Z",
        },
        amount_is_cents=True,
    )
    assert cents_env.amount == Decimal("25.05")

    with pytest.raises(ValidationError):
        normalize_event(
            {
                "event_id": "n-bad",
                "tenant_id": "",
                "seq_id": 1,
                "amount": "1.00",
                "occurred_at": "2026-11-01T10:00:00Z",
            }
        )
    with pytest.raises(ValidationError):
        normalize_event(
            {
                "event_id": "n-bad2",
                "tenant_id": "acme",
                "seq_id": 1,
                "amount": "NaN",
                "occurred_at": "2026-11-01T10:00:00Z",
            }
        )


def test_all_16_connectors_migrated_and_no_private_copies():
    for n in range(1, 5):
        mod = importlib.import_module(f"chronos.connectors.conn_{n:02d}")
        src = inspect.getsource(mod)
        assert "def _clean_amount" not in src
        assert "def _parse_ts" not in src
        env = mod.ingest(
            {
                "event_id": f"e-{n}",
                "tenant": "t1",
                "seq_id": 1,
                "amount": "$10.10",
                "occurred_at": "2026-11-01T01:00:00Z",
            }
        )
        assert env.amount == Decimal("10.10")
        assert env.occurred_at.tzinfo == timezone.utc

    for n in range(5, 9):
        mod = importlib.import_module(f"chronos.connectors.conn_{n:02d}")
        src = inspect.getsource(mod)
        assert "def _clean_amount" not in src
        assert "def _parse_ts" not in src
        cls = getattr(mod, f"Connector{n:02d}")
        seen = []
        inst = cls(hook=seen.append)
        env = inst.transform(
            {
                "event_id": f"e-{n}",
                "tenant_id": "t2",
                "seq_id": 1,
                "amount": "20.20",
                "occurred_at": "2026-11-01T02:00:00+02:00",
            },
            ctx={"default_currency": "gbp"},
        )
        assert len(seen) == 1
        assert env.currency == "GBP"
        assert env.amount == Decimal("20.20")
        assert env.occurred_at.hour == 0

    for n in range(9, 13):
        mod = importlib.import_module(f"chronos.connectors.conn_{n:02d}")
        src = inspect.getsource(mod)
        assert "def _clean_amount" not in src
        assert "def _parse_ts" not in src
        env = mod.ingest(
            {
                "event_id": f"e-{n}",
                "tenant_id": "t3",
                "seq_id": 1,
                "amount_cents": 3035,
                "occurred_at": "2026-11-01T03:00:00Z",
            }
        )
        assert env.amount == Decimal("30.35")

    expected_offsets = {13: 2, 14: -5, 15: 9, 16: 0}
    for n in range(13, 17):
        mod = importlib.import_module(f"chronos.connectors.regional.conn_{n:02d}")
        src = inspect.getsource(mod)
        assert "def _clean_amount" not in src
        assert "def _parse_ts" not in src
        env = mod.ingest(
            {
                "event_id": f"e-{n}",
                "tenant_id": "t4",
                "seq_id": 1,
                "amount": "1,000.05",
                "occurred_at": "2026-11-01 12:00:00",
            }
        )
        assert env.amount == Decimal("1000.05")
        expected_utc = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc) - timedelta(hours=expected_offsets[n])
        assert env.occurred_at == expected_utc


def test_thousand_event_penny_precision_and_replay_strict():
    ts = datetime(2026, 11, 1, 0, 0, tzinfo=timezone.utc)
    events = [
        EventEnvelope(f"id-{i}", "big", i + 1, Decimal("0.10"), "USD", ts, kind="charge", metadata=None)  # type: ignore[arg-type]
        for i in range(1000)
    ]
    events.append(EventEnvelope("ref-1", "big", 1001, Decimal("0.50"), "USD", ts, kind="refund", metadata={}))
    rec = reconcile_tenant(events)
    assert rec["totals"]["USD"] == Decimal("99.50")

    repo_root = Path(__file__).resolve().parent.parent
    proc = subprocess.run(
        [sys.executable, "scripts/replay_incidents.py", "--strict"],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stdout[-1000:] + proc.stderr[-1000:]
