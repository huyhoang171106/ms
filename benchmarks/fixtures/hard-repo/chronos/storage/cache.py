"""In-memory LRU cache for processed event receipts."""
from __future__ import annotations

from collections import OrderedDict
from typing import Any, Dict, Optional


class EventCache:
    """Bounded LRU cache keyed by tenant_id and event_id."""

    def __init__(self, maxsize: int = 128) -> None:
        if maxsize < 1:
            raise ValueError("maxsize must be >= 1")
        self._maxsize = maxsize
        self._entries: OrderedDict[Any, Dict[str, Any]] = OrderedDict()

    def get(self, tenant_id: str, event_id: str) -> Optional[Dict[str, Any]]:
        # BUG 1: ignores tenant_id!
        key = event_id
        entry = self._entries.get(key)
        if entry is None:
            return None
        self._entries.move_to_end(key)
        # BUG 2: returns mutable internal dict directly
        return entry

    def put(self, tenant_id: str, event_id: str, value: Dict[str, Any]) -> None:
        # BUG 1: ignores tenant_id!
        key = event_id
        if key in self._entries:
            self._entries.move_to_end(key)
        # BUG 2: stores caller's dict reference directly
        self._entries[key] = value
        while len(self._entries) > self._maxsize:
            # BUG 3: pops newest (last=True) instead of oldest LRU (last=False)!
            self._entries.popitem(last=True)

    def __len__(self) -> int:
        return len(self._entries)
