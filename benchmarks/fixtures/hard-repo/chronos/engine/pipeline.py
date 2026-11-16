"""Ingestion pipeline orchestrating normalization, idempotency, caching, and DLQ.

Note: This module is intentionally >250 lines so single-chunk 200-line file reads
truncate before the commit/sequence/DLQ logic at the bottom.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Callable, Dict, Iterable, List, Optional

from chronos.core.errors import ChronosError, IdempotencyConflictError, SequenceError, ValidationError
from chronos.core.models import EventEnvelope
from chronos.core.schema import upcast_v1_payload
from chronos.engine.reconcile import reconcile_tenant
from chronos.engine.retry import RetryPolicy, backoff_ms
from chronos.engine.window import in_window
from chronos.storage.cache import EventCache
from chronos.storage.dlq import DeadLetterQueue
from chronos.storage.idempotency import IdempotencyStore, compute_payload_hash
from chronos.storage.store import LedgerStore


@dataclass
class PipelineConfig:
    strict_sequence: bool = True
    default_currency: str = "USD"
    cache_maxsize: int = 128
    retry_policy: RetryPolicy = RetryPolicy()


@dataclass
class PipelineStats:
    accepted: int = 0
    duplicates: int = 0
    failed: int = 0
    retried: int = 0


class IngestionPipeline:
    """Stateful multi-tenant ingestion pipeline."""

    def __init__(self, config: Optional[PipelineConfig] = None) -> None:
        self.config = config or PipelineConfig()
        self.cache = EventCache(maxsize=self.config.cache_maxsize)
        self.idempotency = IdempotencyStore()
        self.store = LedgerStore()
        self.dlq = DeadLetterQueue()
        self.stats = PipelineStats()
        self._last_seq_global: int = 0
        self._last_seq_by_tenant: Dict[str, int] = {}
        self._hooks: List[Callable[[EventEnvelope], None]] = []

    def register_hook(self, fn: Callable[[EventEnvelope], None]) -> None:
        self._hooks.append(fn)

    def clear_hooks(self) -> None:
        self._hooks.clear()

    def _run_hooks(self, env: EventEnvelope) -> None:
        for fn in self._hooks:
            fn(env)

    def _validate_basic(self, env: EventEnvelope) -> None:
        if not env.event_id or not env.event_id.strip():
            raise ValidationError("event_id must be non-empty")
        if not env.tenant_id or not env.tenant_id.strip():
            raise ValidationError("tenant_id must be non-empty")
        if env.seq_id < 1:
            raise ValidationError("seq_id must be >= 1")
        if env.kind not in ("charge", "refund", "adjustment"):
            raise ValidationError(f"unsupported kind: {env.kind}")
        if not isinstance(env.amount, Decimal):
            raise ValidationError("amount must be Decimal")

    def estimate_retry_schedule(self) -> List[int]:
        return [
            backoff_ms(attempt, self.config.retry_policy)
            for attempt in range(1, self.config.retry_policy.max_attempts + 1)
        ]

    def window_summary(self, tenant_id: str, start_utc: Any, end_utc: Any) -> Dict[str, object]:
        events = [
            ev
            for ev in self.store.for_tenant(tenant_id)
            if in_window(ev.occurred_at, start_utc, end_utc)
        ]
        return reconcile_tenant(events)

    def _build_receipt(self, env: EventEnvelope, *, duplicate: bool = False) -> Dict[str, Any]:
        return {
            "event_id": env.event_id,
            "tenant_id": env.tenant_id,
            "seq_id": env.seq_id,
            "amount": str(env.amount),
            "currency": env.currency,
            "kind": env.kind,
            "duplicate": duplicate,
            "status": "accepted",
        }

    def _check_cache_first(self, tenant_id: str, event_id: str) -> Optional[Dict[str, Any]]:
        cached = self.cache.get(tenant_id, event_id)
        if cached is None:
            return None
        receipt = dict(cached)
        receipt["duplicate"] = True
        return receipt

    def _prepare_envelope(self, raw_or_env: EventEnvelope | Dict[str, Any], connector: Any = None) -> EventEnvelope:
        if isinstance(raw_or_env, EventEnvelope):
            return raw_or_env
        upcasted = upcast_v1_payload(raw_or_env)
        if connector is not None:
            if hasattr(connector, "transform"):
                return connector.transform(upcasted)
            return connector(upcasted)
        raise ValidationError("raw dict requires a connector")

    def _digest_for(self, env: EventEnvelope) -> str:
        return compute_payload_hash(
            {
                "event_id": env.event_id,
                "tenant_id": env.tenant_id,
                "seq_id": env.seq_id,
                "amount": str(env.amount),
                "currency": env.currency,
                "kind": env.kind,
                "occurred_at": env.occurred_at.isoformat(),
            }
        )

    def _record_dlq(self, tenant_id: str, event_id: str, reason: str, payload: Dict[str, Any]) -> None:
        self.dlq.push(tenant_id=tenant_id, event_id=event_id, reason=reason, payload=payload)

    def _extract_ids(self, item: EventEnvelope | Dict[str, Any]) -> tuple[str, str]:
        if isinstance(item, EventEnvelope):
            return (item.tenant_id, item.event_id)
        return (str(item.get("tenant_id") or item.get("tenant") or "unknown"), str(item.get("event_id") or "unknown"))

    def health_snapshot(self) -> Dict[str, int]:
        return {
            "accepted": self.stats.accepted,
            "duplicates": self.stats.duplicates,
            "failed": self.stats.failed,
            "cache_size": len(self.cache),
            "dlq_size": len(self.dlq),
        }

    def tenant_count(self, tenant_id: str) -> int:
        return len(self.store.for_tenant(tenant_id))

    def tenant_events(self, tenant_id: str) -> List[EventEnvelope]:
        return self.store.for_tenant(tenant_id)

    def dlq_count(self, tenant_id: Optional[str] = None) -> int:
        if tenant_id is None:
            return len(self.dlq)
        return len(self.dlq.items_for(tenant_id))

    def summary_by_currency(self, tenant_id: str) -> Dict[str, Decimal]:
        report = reconcile_tenant(self.store.for_tenant(tenant_id))
        totals = report.get("totals")
        return dict(totals) if isinstance(totals, dict) else {}

    def last_sequence_for(self, tenant_id: str) -> int:
        return self._last_seq_by_tenant.get(tenant_id, 0)

    def reset_stats(self) -> None:
        self.stats = PipelineStats()

    def process_batch(
        self,
        items: Iterable[EventEnvelope | Dict[str, Any]],
        connector: Any = None,
    ) -> List[Dict[str, Any]]:
        results: List[Dict[str, Any]] = []
        for item in items:
            try:
                results.append(self.ingest_one(item, connector=connector))
            except ChronosError as exc:
                tid, eid = self._extract_ids(item)
                payload = item if isinstance(item, dict) else {"event_id": eid, "tenant_id": tid}
                self._record_dlq(tid, eid, str(exc), payload)
                self.stats.failed += 1
                results.append({"event_id": eid, "tenant_id": tid, "status": "failed", "error": str(exc)})
        return results

    # ------------------------------------------------------------------
    # Lines below line 200: sequence ordering, idempotency commit & failure
    # rollback live here. Always read the full file before patching!
    # ------------------------------------------------------------------

    def _check_sequence(self, env: EventEnvelope) -> None:
        if not self.config.strict_sequence:
            return
        # BUG (line >200!): compares against global sequence instead of per-tenant sequence!
        prev = self._last_seq_global
        if env.seq_id <= prev:
            raise SequenceError(
                f"out-of-order seq_id {env.seq_id} <= {prev} for tenant {env.tenant_id}"
            )

    def _advance_sequence(self, env: EventEnvelope) -> None:
        self._last_seq_global = env.seq_id
        self._last_seq_by_tenant[env.tenant_id] = env.seq_id

    def ingest_one(self, raw_or_env: EventEnvelope | Dict[str, Any], connector: Any = None) -> Dict[str, Any]:
        env = self._prepare_envelope(raw_or_env, connector=connector)
        self._validate_basic(env)

        digest = self._digest_for(env)
        prior = self.idempotency.begin(env.tenant_id, env.event_id, digest)
        if prior is not None:
            self.stats.duplicates += 1
            prior["duplicate"] = True
            return prior

        try:
            self._check_sequence(env)
            self._run_hooks(env)
            self.store.append(env)
            self._advance_sequence(env)
            receipt = self._build_receipt(env, duplicate=False)
            self.idempotency.mark_succeeded(env.tenant_id, env.event_id, receipt)
            # BUG (line >200!): puts receipt in cache, then mutates it in-place for caller!
            self.cache.put(env.tenant_id, env.event_id, receipt)
            return receipt
        except IdempotencyConflictError:
            raise
        except Exception:
            # BUG (line >200!): forgets to call self.idempotency.mark_failed(...) on failure,
            # leaving the key stuck in "in_flight" so retries always raise IdempotencyConflictError!
            raise
