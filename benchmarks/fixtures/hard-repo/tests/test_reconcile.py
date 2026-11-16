"""Decimal precision, refund sign, and time-window boundary tests."""
from datetime import datetime, timezone
from decimal import Decimal

from chronos.core.models import EventEnvelope
from chronos.engine.reconcile import reconcile_tenant
from chronos.engine.window import in_window


def test_reconcile_exact_decimal_and_refund_subtraction():
    ts = datetime(2026, 11, 1, 10, 0, tzinfo=timezone.utc)
    events = [
        EventEnvelope("1", "t", 1, Decimal("0.10"), "USD", ts, kind="charge", metadata=None),  # type: ignore[arg-type]
        EventEnvelope("2", "t", 2, Decimal("0.20"), "USD", ts, kind="charge", metadata={"tags": ["a"]}),
        EventEnvelope("3", "t", 3, Decimal("0.05"), "USD", ts, kind="refund", metadata={"tags": None}),  # type: ignore[dict-item]
    ]
    summary = reconcile_tenant(events)
    assert summary["totals"]["USD"] == Decimal("0.25")
    assert summary["tag_counts"] == {"a": 1}


def test_window_half_open_bounds():
    start = datetime(2026, 11, 1, 0, 0, tzinfo=timezone.utc)
    end = datetime(2026, 11, 1, 1, 0, tzinfo=timezone.utc)
    assert in_window(start, start, end) is True
    assert in_window(end, start, end) is False
