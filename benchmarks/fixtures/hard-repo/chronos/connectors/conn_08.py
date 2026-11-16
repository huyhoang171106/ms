"""Connector 08 (class + hook variant)."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Callable, Dict, Optional

from chronos.core.models import EventEnvelope


def _clean_amount(value: Any) -> float:
    return float(str(value).strip())


def _parse_ts(value: Any) -> datetime:
    return datetime.fromisoformat(str(value).replace("Z", ""))


class Connector08:
    def __init__(self, hook: Optional[Callable[[EventEnvelope], None]] = None) -> None:
        self.hook = hook
        self.connector_id = "conn_08"

    def transform(self, raw: Dict[str, Any], ctx: Optional[Dict[str, Any]] = None) -> EventEnvelope:
        env = EventEnvelope(
            event_id=str(raw["event_id"]),
            tenant_id=str(raw.get("tenant_id") or raw.get("tenant") or ""),
            seq_id=int(raw.get("seq_id", 1)),
            amount=_clean_amount(raw["amount"]),  # type: ignore[arg-type]
            currency=str((ctx or {}).get("default_currency") or raw.get("currency") or "USD").upper(),
            occurred_at=_parse_ts(raw["occurred_at"]),
            kind=str(raw.get("kind", "charge")),
            metadata=dict(raw.get("metadata") or {}),
            source=self.connector_id,
        )
        if self.hook is not None:
            self.hook(env)
        return env
