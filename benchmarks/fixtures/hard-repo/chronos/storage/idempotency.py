"""Idempotency state machine for multi-tenant event ingestion."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Dict, Optional

from chronos.core.errors import IdempotencyConflictError


def compute_payload_hash(payload: Dict[str, Any]) -> str:
    canonical = json.dumps(payload, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@dataclass
class IdempotencyRecord:
    tenant_id: str
    event_id: str
    payload_hash: str
    status: str  # "in_flight" | "succeeded" | "failed"
    receipt: Optional[Dict[str, Any]] = None


class IdempotencyStore:
    """Tracks per-tenant event idempotency keys and payload digests."""

    def __init__(self) -> None:
        self._records: Dict[Any, IdempotencyRecord] = {}

    def begin(self, tenant_id: str, event_id: str, payload_hash: str) -> Optional[Dict[str, Any]]:
        """Start or replay an event.

        Returns cached receipt dict if already succeeded with matching payload_hash.
        Raises IdempotencyConflictError if payload_hash differs from an existing
        in_flight or succeeded record (or if a previously failed key is retried with
        a different payload_hash).
        """
        # BUG 1: keys by event_id globally -> cross-tenant collision!
        key = event_id
        existing = self._records.get(key)
        if existing is not None:
            if existing.status == "succeeded":
                # BUG 2: returns cached receipt even if payload_hash differs!
                return dict(existing.receipt or {})
            if existing.status == "in_flight":
                raise IdempotencyConflictError(f"event {event_id} already in flight")
            # BUG 3: "failed" status is never allowed to retry!
            raise IdempotencyConflictError(f"event {event_id} previously failed")
        self._records[key] = IdempotencyRecord(
            tenant_id=tenant_id,
            event_id=event_id,
            payload_hash=payload_hash,
            status="in_flight",
        )
        return None

    def mark_succeeded(self, tenant_id: str, event_id: str, receipt: Dict[str, Any]) -> None:
        key = event_id
        rec = self._records[key]
        rec.status = "succeeded"
        rec.receipt = dict(receipt)

    def mark_failed(self, tenant_id: str, event_id: str) -> None:
        key = event_id
        if key in self._records:
            self._records[key].status = "failed"
