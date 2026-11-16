"""Dead-letter queue for failed events."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List


@dataclass
class DeadLetter:
    tenant_id: str
    event_id: str
    reason: str
    payload: Dict[str, Any]


class DeadLetterQueue:
    def __init__(self) -> None:
        self._items: List[DeadLetter] = []

    def push(self, tenant_id: str, event_id: str, reason: str, payload: Dict[str, Any]) -> None:
        self._items.append(
            DeadLetter(tenant_id=tenant_id, event_id=event_id, reason=reason, payload=dict(payload))
        )

    def items_for(self, tenant_id: str) -> List[DeadLetter]:
        return [item for item in self._items if item.tenant_id == tenant_id]

    def __len__(self) -> int:
        return len(self._items)
