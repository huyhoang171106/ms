#!/usr/bin/env python3
"""Replays noisy multi-tenant incident stream (~3,600 lines of logs).

Exit code 0 iff all 4 buried incident checks pass under `--strict`.
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from chronos.connectors import conn_01, conn_05, conn_09  # noqa: E402
from chronos.connectors.regional import conn_13  # noqa: E402
from chronos.core.errors import ChronosError, IdempotencyConflictError  # noqa: E402
from chronos.core.models import EventEnvelope  # noqa: E402
from chronos.engine.pipeline import IngestionPipeline, PipelineConfig  # noqa: E402
from chronos.engine.reconcile import reconcile_tenant  # noqa: E402
from chronos.engine.window import in_window  # noqa: E402


def _emit_noise(batch_idx: int, count: int) -> None:
    for i in range(count):
        print(
            f"[INFO] batch={batch_idx:02d} seq={i:04d} heartbeat=ok "
            f"queue_depth={(i * 7) % 13} worker=w{(i % 4) + 1} latency_ms={12 + (i % 19)}"
        )


def run_replay(strict: bool = False) -> int:
    failures: list[str] = []
    print("[INFO] chronos incident replay starting (3,600+ telemetry lines)")
    _emit_noise(1, 880)

    # Incident 1: Cross-tenant idempotency + cache + per-tenant sequence ordering
    try:
        pipe = IngestionPipeline(PipelineConfig(strict_sequence=True))
        r1 = pipe.ingest_one(
            {
                "event_id": "evt-shared-001",
                "tenant": "acme",
                "seq_id": 1,
                "amount": "10.00",
                "occurred_at": "2026-11-01T10:00:00Z",
                "metadata": None,
            },
            connector=conn_01.ingest,
        )
        r2 = pipe.ingest_one(
            {
                "event_id": "evt-shared-001",
                "tenant_id": "globex",
                "seq_id": 1,
                "amount": "25.50",
                "occurred_at": "2026-11-01T10:01:00Z",
            },
            connector=conn_05.Connector05().transform,
        )
        assert r1["tenant_id"] == "acme" and r2["tenant_id"] == "globex"
        assert pipe.cache.get("acme", "evt-shared-001") is not None
        assert pipe.cache.get("globex", "evt-shared-001") is not None
    except Exception as exc:
        msg = f"[INCIDENT-01] cross-tenant isolation/sequence failed: {type(exc).__name__}: {exc}"
        print(msg)
        failures.append(msg)

    _emit_noise(2, 900)

    # Incident 2: Failed attempt retry + payload mismatch conflict
    try:
        pipe2 = IngestionPipeline(PipelineConfig(strict_sequence=True))
        should_fail = True

        def flaky_hook(_env: EventEnvelope) -> None:
            if should_fail:
                raise RuntimeError("transient downstream timeout")

        pipe2.register_hook(flaky_hook)
        raw = {
            "event_id": "evt-retry-1",
            "tenant_id": "acme",
            "seq_id": 1,
            "amount_cents": 1995,
            "occurred_at": "2026-11-01T12:00:00Z",
        }
        try:
            pipe2.ingest_one(raw, connector=conn_09.ingest)
        except RuntimeError:
            pass
        should_fail = False
        retried = pipe2.ingest_one(raw, connector=conn_09.ingest)
        assert retried["amount"] == "19.95"
        try:
            pipe2.ingest_one(
                {**raw, "amount_cents": 2000},
                connector=conn_09.ingest,
            )
            raise AssertionError("expected IdempotencyConflictError on mismatched retry payload")
        except IdempotencyConflictError:
            pass
    except Exception as exc:
        msg = f"[INCIDENT-02] idempotency retry/conflict failed: {type(exc).__name__}: {exc}"
        print(msg)
        failures.append(msg)

    _emit_noise(3, 900)

    # Incident 3: Decimal precision + refunds + regional timezone + window boundaries
    try:
        ev_c = conn_13.ingest(
            {
                "event_id": "reg-1",
                "tenant_id": "eu-corp",
                "seq_id": 1,
                "amount": "0.10",
                "occurred_at": "2026-11-01 10:00:00",
                "kind": "charge",
                "metadata": None,
            }
        )
        ev_c2 = conn_13.ingest(
            {
                "event_id": "reg-2",
                "tenant_id": "eu-corp",
                "seq_id": 2,
                "amount": "0.20",
                "occurred_at": "2026-11-01T10:00:00+02:00",
                "kind": "charge",
                "metadata": {"tags": ["vip"]},
            }
        )
        ev_r = conn_13.ingest(
            {
                "event_id": "reg-3",
                "tenant_id": "eu-corp",
                "seq_id": 3,
                "amount": "0.05",
                "occurred_at": "2026-11-01T08:00:00Z",
                "kind": "refund",
            }
        )
        rec = reconcile_tenant([ev_c, ev_c2, ev_r])
        assert rec["totals"]["USD"] == Decimal("0.25"), f"got {rec['totals']}"
        start = datetime(2026, 11, 1, 8, 0, 0, tzinfo=timezone.utc)
        end = datetime(2026, 11, 1, 9, 0, 0, tzinfo=timezone.utc)
        assert in_window(ev_c.occurred_at, start, end) is True
        assert in_window(end, start, end) is False
    except Exception as exc:
        msg = f"[INCIDENT-03] decimal/refund/window/tz failed: {type(exc).__name__}: {exc}"
        print(msg)
        failures.append(msg)

    _emit_noise(4, 900)

    # Incident 4: Cache isolation & LRU eviction
    try:
        pipe4 = IngestionPipeline(PipelineConfig(cache_maxsize=2, strict_sequence=False))
        r_a = pipe4.ingest_one(
            {
                "event_id": "e1",
                "tenant_id": "t1",
                "seq_id": 1,
                "amount": "5.00",
                "occurred_at": "2026-11-01T00:00:00Z",
            },
            connector=conn_01.ingest,
        )
        r_a["status"] = "CORRUPTED_BY_CALLER"
        fresh = pipe4.cache.get("t1", "e1")
        assert fresh is not None and fresh["status"] == "accepted"
        pipe4.ingest_one(
            {
                "event_id": "e2",
                "tenant_id": "t1",
                "seq_id": 2,
                "amount": "5.00",
                "occurred_at": "2026-11-01T00:01:00Z",
            },
            connector=conn_01.ingest,
        )
        assert pipe4.cache.get("t1", "e1") is not None  # touch e1 -> e2 is LRU
        pipe4.ingest_one(
            {
                "event_id": "e3",
                "tenant_id": "t1",
                "seq_id": 3,
                "amount": "5.00",
                "occurred_at": "2026-11-01T00:02:00Z",
            },
            connector=conn_01.ingest,
        )
        assert pipe4.cache.get("t1", "e1") is not None
        assert pipe4.cache.get("t1", "e2") is None
    except Exception as exc:
        msg = f"[INCIDENT-04] cache isolation/LRU failed: {type(exc).__name__}: {exc}"
        print(msg)
        failures.append(msg)

    print(f"[SUMMARY] replay complete: failures={len(failures)}")
    if strict and failures:
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()
    return run_replay(strict=args.strict)


if __name__ == "__main__":
    sys.exit(main())
