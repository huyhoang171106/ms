"""In-memory ledger store."""
from __future__ import annotations

from typing import Dict, List

from chronos.core.models import EventEnvelope


class LedgerStore:
    def __init__(self) -> None:
        self._events: Dict[str, List[EventEnvelope]] = {}

    def append(self, env: EventEnvelope) -> None:
        self._events.setdefault(env.tenant_id, []).append(env)

    def for_tenant(self, tenant_id: str) -> List[EventEnvelope]:
        return list(self._events.get(tenant_id, ()))

    def all_events(self) -> List[EventEnvelope]:
        out: List[EventEnvelope] = []
        for items in self._events.values():
            out.extend(items)
        return out
