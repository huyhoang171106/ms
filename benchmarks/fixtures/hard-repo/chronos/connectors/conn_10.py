"""Connector 10 (integer-cents input variant)."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict

from chronos.core.models import EventEnvelope


def _clean_amount(cents: Any) -> float:
    return round(int(cents) / 100.0, 2)


def _parse_ts(value: Any) -> datetime:
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).replace(tzinfo=None)


def ingest(raw: Dict[str, Any]) -> EventEnvelope:
    cents_val = raw["amount_cents"] if "amount_cents" in raw else raw["amount"]
    return EventEnvelope(
        event_id=str(raw["event_id"]),
        tenant_id=str(raw.get("tenant_id") or raw.get("tenant") or ""),
        seq_id=int(raw.get("seq_id", 1)),
        amount=_clean_amount(cents_val),  # type: ignore[arg-type]
        currency=str(raw.get("currency", "USD")).upper(),
        occurred_at=_parse_ts(raw["occurred_at"]),
        kind=str(raw.get("kind", "charge")),
        metadata=dict(raw.get("metadata") or {}),
        source="conn_10",
    )
