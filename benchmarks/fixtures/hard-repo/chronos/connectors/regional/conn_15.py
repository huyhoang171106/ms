"""Regional connector 15 (regional tz-offset=+9 variant)."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict

from chronos.core.models import EventEnvelope

DEFAULT_TZ_OFFSET_HOURS = 9


def _clean_amount(value: Any) -> float:
    return float(str(value).replace(",", "").strip())


def _parse_ts(value: Any) -> datetime:
    return datetime.fromisoformat(str(value).replace(" ", "T"))


def ingest(raw: Dict[str, Any], *, region: str = "reg_15") -> EventEnvelope:
    return EventEnvelope(
        event_id=str(raw["event_id"]),
        tenant_id=str(raw.get("tenant_id") or raw.get("tenant") or ""),
        seq_id=int(raw.get("seq_id", 1)),
        amount=_clean_amount(raw["amount"]),  # type: ignore[arg-type]
        currency=str(raw.get("currency", "USD")).upper(),
        occurred_at=_parse_ts(raw["occurred_at"]),
        kind=str(raw.get("kind", "charge")),
        metadata=dict(raw.get("metadata") or {}),
        source="conn_15",
        region=region,
    )
