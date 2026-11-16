"""Connector normalization & Decimal/UTC checks across all 16 connectors."""
from datetime import timezone
from decimal import Decimal

from chronos.connectors import conn_01, conn_05, conn_09
from chronos.connectors.regional import conn_13


def test_variant_a_decimal_and_utc():
    env = conn_01.ingest(
        {
            "event_id": "a1",
            "tenant": "acme",
            "seq_id": 1,
            "amount": "$12.50",
            "occurred_at": "2026-11-01T10:00:00Z",
        }
    )
    assert env.tenant_id == "acme"
    assert isinstance(env.amount, Decimal) and env.amount == Decimal("12.50")
    assert env.occurred_at.tzinfo == timezone.utc


def test_variant_b_hook_and_decimal():
    seen = []
    c = conn_05.Connector05(hook=seen.append)
    env = c.transform(
        {
            "event_id": "b1",
            "tenant_id": "globex",
            "seq_id": 1,
            "amount": "7.25",
            "occurred_at": "2026-11-01T10:00:00+02:00",
        }
    )
    assert len(seen) == 1
    assert isinstance(env.amount, Decimal) and env.amount == Decimal("7.25")
    assert env.occurred_at.utcoffset().total_seconds() == 0
    assert env.occurred_at.hour == 8


def test_variant_c_cents_conversion():
    env = conn_09.ingest(
        {
            "event_id": "c1",
            "tenant_id": "acme",
            "seq_id": 1,
            "amount_cents": 1995,
            "occurred_at": "2026-11-01T10:00:00Z",
        }
    )
    assert isinstance(env.amount, Decimal) and env.amount == Decimal("19.95")


def test_variant_d_regional_offset():
    env = conn_13.ingest(
        {
            "event_id": "d1",
            "tenant_id": "eu",
            "seq_id": 1,
            "amount": "1,234.50",
            "occurred_at": "2026-11-01 10:00:00",
        }
    )
    assert isinstance(env.amount, Decimal) and env.amount == Decimal("1234.50")
    assert env.occurred_at.tzinfo == timezone.utc
    assert env.occurred_at.hour == 8
