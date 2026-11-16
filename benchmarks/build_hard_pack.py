#!/usr/bin/env python3
"""Builds benchmarks/fixtures/hard-repo and benchmarks/hidden/test_hard_hidden.py.

A genuinely hard, multi-step engineering benchmark ("chronos"):
1. Noisy log triage: `python3 scripts/replay_incidents.py --strict` emits ~3,600 lines (~260 KB)
   of DEBUG/INFO stream with 4 buried `[INCIDENT-0X]` failures.
2. Coupled subsystem bugs across 4 layers (schema/normalize, cache, idempotency, window/reconcile)
   plus a >260-line `chronos/engine/pipeline.py` whose bottom half (lines 195-265) holds two
   critical bugs (so 200-line truncated reads miss them).
3. 16 heterogeneous connector modules across 2 directories (`connectors/` and `connectors/regional/`)
   with 4 distinct structural variants (sync fn, class+hook, cents-input, regional tz-offset)
   that all carry buggy private `_clean_amount` / `_parse_ts` copies.
4. Decoy `chronos/legacy/v1_compat.py` that must stay intact.
5. Hidden verification suite kept outside the workspace until grading.
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TARGET = ROOT / "fixtures" / "hard-repo"
HIDDEN_DIR = ROOT / "hidden"

STATIC_FILES: dict[str, str] = {
    "pytest.ini": "[pytest]\ntestpaths = tests\npythonpath = .\n",
    "README.md": (
        "# Chronos Ledger Pipeline\n\n"
        "Multi-tenant billing event normalizer, idempotency store, and batch reconciler.\n"
        "Run `python3 -m pytest -q` and `python3 scripts/replay_incidents.py --strict`.\n"
    ),
    "chronos/__init__.py": '"""Chronos ledger pipeline."""\n__version__ = "2.0.0"\n',
    "chronos/core/__init__.py": "",
    "chronos/core/errors.py": '''"""Domain errors for Chronos."""


class ChronosError(Exception):
    """Base error."""


class ValidationError(ChronosError):
    """Raised when an event payload violates schema rules."""


class IdempotencyConflictError(ChronosError):
    """Raised when the same tenant+event_id is reused with a different payload."""


class SequenceError(ChronosError):
    """Raised when a tenant event arrives out of monotonic sequence order."""
''',
    "chronos/core/models.py": '''"""Core data models."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any, Dict


@dataclass
class EventEnvelope:
    event_id: str
    tenant_id: str
    seq_id: int
    amount: Decimal
    currency: str
    occurred_at: datetime
    kind: str = "charge"
    metadata: Dict[str, Any] = field(default_factory=dict)
    schema_version: int = 2
    source: str = "unknown"
    region: str = "global"
''',
    "chronos/core/schema.py": '''"""Event schema validation and v1->v2 upcasting."""
from __future__ import annotations

from typing import Any, Dict

from chronos.core.errors import ValidationError


def upcast_v1_payload(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Upcast a v1 event dictionary into v2 field names without mutating input."""
    if not isinstance(raw, dict):
        raise ValidationError("payload must be a dict")
    out = dict(raw)
    # BUG: drops legacy `tenant` when `tenant_id` missing, and crashes on metadata=None later
    if "version" in out and "schema_version" not in out:
        out["schema_version"] = out.pop("version")
    return out
''',
    "chronos/storage/__init__.py": "",
    "chronos/storage/cache.py": '''"""In-memory LRU cache for processed event receipts."""
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
''',
    "chronos/storage/idempotency.py": '''"""Idempotency state machine for multi-tenant event ingestion."""
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
''',
    "chronos/storage/dlq.py": '''"""Dead-letter queue for failed events."""
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
''',
    "chronos/storage/store.py": '''"""In-memory ledger store."""
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
''',
    "chronos/engine/__init__.py": "",
    "chronos/engine/window.py": '''"""Time-window filtering for UTC ledger intervals."""
from __future__ import annotations

from datetime import datetime, timezone


def _to_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def in_window(occurred_at: datetime, start_utc: datetime, end_utc: datetime) -> bool:
    """Return True iff occurred_at falls inside half-open [start_utc, end_utc)."""
    ts = _to_utc(occurred_at)
    lo = _to_utc(start_utc)
    hi = _to_utc(end_utc)
    # BUG: uses (lo, hi] instead of [lo, hi)
    return lo < ts <= hi
''',
    "chronos/engine/reconcile.py": '''"""Batch ledger reconciliation."""
from __future__ import annotations

from decimal import Decimal
from typing import Dict, Iterable

from chronos.core.models import EventEnvelope


def reconcile_tenant(events: Iterable[EventEnvelope]) -> Dict[str, object]:
    """Compute net total per currency and tag summary using exact Decimal math."""
    # BUG 1: uses float instead of Decimal -> penny drift on large sums!
    totals: Dict[str, float] = {}
    tag_counts: Dict[str, int] = {}
    count = 0
    for ev in events:
        count += 1
        cur = ev.currency
        # BUG 2: adds refund instead of subtracting it!
        signed = float(ev.amount)
        totals[cur] = totals.get(cur, 0.0) + signed
        # BUG 3: crashes if metadata is None or metadata["tags"] is None!
        for tag in ev.metadata.get("tags", []):
            tag_counts[tag] = tag_counts.get(tag, 0) + 1
    return {
        "count": count,
        "totals": {k: Decimal(str(round(v, 2))) for k, v in totals.items()},
        "tag_counts": tag_counts,
    }
''',
    "chronos/engine/retry.py": '''"""Retry backoff calculation."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class RetryPolicy:
    max_attempts: int = 4
    base_delay_ms: int = 100
    max_delay_ms: int = 2000


def backoff_ms(attempt: int, policy: RetryPolicy) -> int:
    if attempt <= 0:
        return 0
    return min(policy.base_delay_ms * (2 ** (attempt - 1)), policy.max_delay_ms)
''',
    "chronos/engine/pipeline.py": '''"""Ingestion pipeline orchestrating normalization, idempotency, caching, and DLQ.

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
''',
    "chronos/legacy/__init__.py": "",
    "chronos/legacy/v1_compat.py": '''"""Legacy v1 compatibility helpers (DECOY - keep intact for v1 callers)."""
from __future__ import annotations


def legacy_clean_amount(value: object) -> float:
    """Deprecated v1 float helper kept for backwards compatibility tests."""
    return round(float(str(value).replace("$", "").strip()), 2)


def legacy_tag_line(tags: list[str] | None) -> str:
    return ",".join(sorted(tags or []))
''',
    "chronos/connectors/__init__.py": "",
    "chronos/connectors/regional/__init__.py": "",
    "scripts/replay_incidents.py": '''#!/usr/bin/env python3
"""Replays noisy multi-tenant incident stream (~3,600 lines of logs).

Exit code 0 iff all 4 buried incident checks pass under `--strict`.
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from chronos.connectors import conn_01, conn_05, conn_09  # noqa: E402
from chronos.connectors.regional import conn_13  # noqa: E402
from chronos.core.errors import ChronosError, IdempotencyConflictError  # noqa: E402
from chronos.core.models import EventEnvelope  # noqa: E402
from chronos.engine.pipeline import IngestionPipeline, PipelineConfig  # noqa: E402
from chronos.engine.reconcile import reconcile_tenant  # noqa: E402
from chronos.engine.window import in_window  # noqa: E402


def _emit_noise(batch_idx: int, count: int) -> None:
    for i in range(count):
        print(
            f"[INFO] batch={batch_idx:02d} seq={i:04d} heartbeat=ok "
            f"queue_depth={(i * 7) % 13} worker=w{(i % 4) + 1} latency_ms={12 + (i % 19)}"
        )


def run_replay(strict: bool = False) -> int:
    failures: list[str] = []
    print("[INFO] chronos incident replay starting (3,600+ telemetry lines)")
    _emit_noise(1, 880)

    # Incident 1: Cross-tenant idempotency + cache + per-tenant sequence ordering
    try:
        pipe = IngestionPipeline(PipelineConfig(strict_sequence=True))
        r1 = pipe.ingest_one(
            {
                "event_id": "evt-shared-001",
                "tenant": "acme",
                "seq_id": 1,
                "amount": "10.00",
                "occurred_at": "2026-11-01T10:00:00Z",
                "metadata": None,
            },
            connector=conn_01.ingest,
        )
        r2 = pipe.ingest_one(
            {
                "event_id": "evt-shared-001",
                "tenant_id": "globex",
                "seq_id": 1,
                "amount": "25.50",
                "occurred_at": "2026-11-01T10:01:00Z",
            },
            connector=conn_05.Connector05().transform,
        )
        assert r1["tenant_id"] == "acme" and r2["tenant_id"] == "globex"
        assert pipe.cache.get("acme", "evt-shared-001") is not None
        assert pipe.cache.get("globex", "evt-shared-001") is not None
    except Exception as exc:
        msg = f"[INCIDENT-01] cross-tenant isolation/sequence failed: {type(exc).__name__}: {exc}"
        print(msg)
        failures.append(msg)

    _emit_noise(2, 900)

    # Incident 2: Failed attempt retry + payload mismatch conflict
    try:
        pipe2 = IngestionPipeline(PipelineConfig(strict_sequence=True))
        should_fail = True

        def flaky_hook(_env: EventEnvelope) -> None:
            if should_fail:
                raise RuntimeError("transient downstream timeout")

        pipe2.register_hook(flaky_hook)
        raw = {
            "event_id": "evt-retry-1",
            "tenant_id": "acme",
            "seq_id": 1,
            "amount_cents": 1995,
            "occurred_at": "2026-11-01T12:00:00Z",
        }
        try:
            pipe2.ingest_one(raw, connector=conn_09.ingest)
        except RuntimeError:
            pass
        should_fail = False
        retried = pipe2.ingest_one(raw, connector=conn_09.ingest)
        assert retried["amount"] == "19.95"
        try:
            pipe2.ingest_one(
                {**raw, "amount_cents": 2000},
                connector=conn_09.ingest,
            )
            raise AssertionError("expected IdempotencyConflictError on mismatched retry payload")
        except IdempotencyConflictError:
            pass
    except Exception as exc:
        msg = f"[INCIDENT-02] idempotency retry/conflict failed: {type(exc).__name__}: {exc}"
        print(msg)
        failures.append(msg)

    _emit_noise(3, 900)

    # Incident 3: Decimal precision + refunds + regional timezone + window boundaries
    try:
        ev_c = conn_13.ingest(
            {
                "event_id": "reg-1",
                "tenant_id": "eu-corp",
                "seq_id": 1,
                "amount": "0.10",
                "occurred_at": "2026-11-01 10:00:00",
                "kind": "charge",
                "metadata": None,
            }
        )
        ev_c2 = conn_13.ingest(
            {
                "event_id": "reg-2",
                "tenant_id": "eu-corp",
                "seq_id": 2,
                "amount": "0.20",
                "occurred_at": "2026-11-01T10:00:00+02:00",
                "kind": "charge",
                "metadata": {"tags": ["vip"]},
            }
        )
        ev_r = conn_13.ingest(
            {
                "event_id": "reg-3",
                "tenant_id": "eu-corp",
                "seq_id": 3,
                "amount": "0.05",
                "occurred_at": "2026-11-01T08:00:00Z",
                "kind": "refund",
            }
        )
        rec = reconcile_tenant([ev_c, ev_c2, ev_r])
        assert rec["totals"]["USD"] == Decimal("0.25"), f"got {rec['totals']}"
        start = datetime(2026, 11, 1, 8, 0, 0, tzinfo=timezone.utc)
        end = datetime(2026, 11, 1, 9, 0, 0, tzinfo=timezone.utc)
        assert in_window(ev_c.occurred_at, start, end) is True
        assert in_window(end, start, end) is False
    except Exception as exc:
        msg = f"[INCIDENT-03] decimal/refund/window/tz failed: {type(exc).__name__}: {exc}"
        print(msg)
        failures.append(msg)

    _emit_noise(4, 900)

    # Incident 4: Cache isolation & LRU eviction
    try:
        pipe4 = IngestionPipeline(PipelineConfig(cache_maxsize=2, strict_sequence=False))
        r_a = pipe4.ingest_one(
            {
                "event_id": "e1",
                "tenant_id": "t1",
                "seq_id": 1,
                "amount": "5.00",
                "occurred_at": "2026-11-01T00:00:00Z",
            },
            connector=conn_01.ingest,
        )
        r_a["status"] = "CORRUPTED_BY_CALLER"
        fresh = pipe4.cache.get("t1", "e1")
        assert fresh is not None and fresh["status"] == "accepted"
        pipe4.ingest_one(
            {
                "event_id": "e2",
                "tenant_id": "t1",
                "seq_id": 2,
                "amount": "5.00",
                "occurred_at": "2026-11-01T00:01:00Z",
            },
            connector=conn_01.ingest,
        )
        assert pipe4.cache.get("t1", "e1") is not None  # touch e1 -> e2 is LRU
        pipe4.ingest_one(
            {
                "event_id": "e3",
                "tenant_id": "t1",
                "seq_id": 3,
                "amount": "5.00",
                "occurred_at": "2026-11-01T00:02:00Z",
            },
            connector=conn_01.ingest,
        )
        assert pipe4.cache.get("t1", "e1") is not None
        assert pipe4.cache.get("t1", "e2") is None
    except Exception as exc:
        msg = f"[INCIDENT-04] cache isolation/LRU failed: {type(exc).__name__}: {exc}"
        print(msg)
        failures.append(msg)

    print(f"[SUMMARY] replay complete: failures={len(failures)}")
    if strict and failures:
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()
    return run_replay(strict=args.strict)


if __name__ == "__main__":
    sys.exit(main())
''',
}

# Four heterogeneous connector templates (4 files each = 16 files total)
VARIANT_A = '''"""Connector {n:02d} (sync function variant)."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict

from chronos.core.models import EventEnvelope


def _clean_amount(value: Any) -> float:
    return round(float(str(value).replace("$", "").strip()), 2)


def _parse_ts(value: Any) -> datetime:
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).replace(tzinfo=None)


def ingest(raw: Dict[str, Any], *, source: str = "conn_{n:02d}") -> EventEnvelope:
    return EventEnvelope(
        event_id=str(raw["event_id"]),
        tenant_id=str(raw.get("tenant_id") or raw.get("tenant") or ""),
        seq_id=int(raw.get("seq_id", 1)),
        amount=_clean_amount(raw["amount"]),  # type: ignore[arg-type]
        currency=str(raw.get("currency", "USD")).upper(),
        occurred_at=_parse_ts(raw["occurred_at"]),
        kind=str(raw.get("kind", "charge")),
        metadata=dict(raw.get("metadata") or {{}}),
        source=source,
    )
'''

VARIANT_B = '''"""Connector {n:02d} (class + hook variant)."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Callable, Dict, Optional

from chronos.core.models import EventEnvelope


def _clean_amount(value: Any) -> float:
    return float(str(value).strip())


def _parse_ts(value: Any) -> datetime:
    return datetime.fromisoformat(str(value).replace("Z", ""))


class Connector{n:02d}:
    def __init__(self, hook: Optional[Callable[[EventEnvelope], None]] = None) -> None:
        self.hook = hook
        self.connector_id = "conn_{n:02d}"

    def transform(self, raw: Dict[str, Any], ctx: Optional[Dict[str, Any]] = None) -> EventEnvelope:
        env = EventEnvelope(
            event_id=str(raw["event_id"]),
            tenant_id=str(raw.get("tenant_id") or raw.get("tenant") or ""),
            seq_id=int(raw.get("seq_id", 1)),
            amount=_clean_amount(raw["amount"]),  # type: ignore[arg-type]
            currency=str((ctx or {{}}).get("default_currency") or raw.get("currency") or "USD").upper(),
            occurred_at=_parse_ts(raw["occurred_at"]),
            kind=str(raw.get("kind", "charge")),
            metadata=dict(raw.get("metadata") or {{}}),
            source=self.connector_id,
        )
        if self.hook is not None:
            self.hook(env)
        return env
'''

VARIANT_C = '''"""Connector {n:02d} (integer-cents input variant)."""
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
        metadata=dict(raw.get("metadata") or {{}}),
        source="conn_{n:02d}",
    )
'''

REGIONAL_OFFSETS = {13: 2, 14: -5, 15: 9, 16: 0}

VARIANT_D = '''"""Regional connector {n:02d} (regional tz-offset={offset:+d} variant)."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict

from chronos.core.models import EventEnvelope

DEFAULT_TZ_OFFSET_HOURS = {offset}


def _clean_amount(value: Any) -> float:
    return float(str(value).replace(",", "").strip())


def _parse_ts(value: Any) -> datetime:
    return datetime.fromisoformat(str(value).replace(" ", "T"))


def ingest(raw: Dict[str, Any], *, region: str = "reg_{n:02d}") -> EventEnvelope:
    return EventEnvelope(
        event_id=str(raw["event_id"]),
        tenant_id=str(raw.get("tenant_id") or raw.get("tenant") or ""),
        seq_id=int(raw.get("seq_id", 1)),
        amount=_clean_amount(raw["amount"]),  # type: ignore[arg-type]
        currency=str(raw.get("currency", "USD")).upper(),
        occurred_at=_parse_ts(raw["occurred_at"]),
        kind=str(raw.get("kind", "charge")),
        metadata=dict(raw.get("metadata") or {{}}),
        source="conn_{n:02d}",
        region=region,
    )
'''

VISIBLE_TESTS: dict[str, str] = {
    "tests/test_legacy.py": '''"""Legacy v1 compatibility must remain untouched."""
from chronos.legacy.v1_compat import legacy_clean_amount, legacy_tag_line


def test_legacy_clean_amount():
    assert legacy_clean_amount("$12.345") == 12.35


def test_legacy_tag_line():
    assert legacy_tag_line(["b", "a"]) == "a,b"
    assert legacy_tag_line(None) == ""
''',
    "tests/test_idempotency.py": '''"""Idempotency and cache isolation tests."""
import pytest

from chronos.core.errors import IdempotencyConflictError
from chronos.storage.cache import EventCache
from chronos.storage.idempotency import IdempotencyStore, compute_payload_hash


def test_cross_tenant_idempotency_keys_do_not_collide():
    store = IdempotencyStore()
    h1 = compute_payload_hash({"tenant_id": "t1", "amount": "10.00"})
    h2 = compute_payload_hash({"tenant_id": "t2", "amount": "20.00"})
    assert store.begin("t1", "evt-1", h1) is None
    assert store.begin("t2", "evt-1", h2) is None
    store.mark_succeeded("t1", "evt-1", {"ok": 1})
    assert store.begin("t1", "evt-1", h1) == {"ok": 1}
    with pytest.raises(IdempotencyConflictError):
        store.begin("t1", "evt-1", h2)


def test_failed_event_can_be_retried():
    store = IdempotencyStore()
    h1 = compute_payload_hash({"a": 1})
    assert store.begin("t1", "evt-retry", h1) is None
    store.mark_failed("t1", "evt-retry")
    assert store.begin("t1", "evt-retry", h1) is None
    store.mark_succeeded("t1", "evt-retry", {"done": True})
    assert store.begin("t1", "evt-retry", h1) == {"done": True}


def test_cache_is_tenant_scoped_copy_safe_and_lru():
    cache = EventCache(maxsize=2)
    orig = {"status": "ok"}
    cache.put("t1", "e1", orig)
    orig["status"] = "mutated"
    got = cache.get("t1", "e1")
    assert got == {"status": "ok"}
    got["status"] = "mutated_again"
    assert cache.get("t1", "e1") == {"status": "ok"}
    assert cache.get("t2", "e1") is None

    cache.put("t1", "e2", {"v": 2})
    assert cache.get("t1", "e1") == {"status": "ok"}  # touch e1
    cache.put("t1", "e3", {"v": 3})
    assert cache.get("t1", "e1") == {"status": "ok"}
    assert cache.get("t1", "e2") is None
''',
    "tests/test_reconcile.py": '''"""Decimal precision, refund sign, and time-window boundary tests."""
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
''',
    "tests/test_connectors.py": '''"""Connector normalization & Decimal/UTC checks across all 16 connectors."""
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
''',
    "tests/test_pipeline.py": '''"""End-to-end pipeline and bulk baseline tests (keep all green)."""
import pytest

from chronos.connectors import conn_01
from chronos.core.errors import IdempotencyConflictError, SequenceError
from chronos.engine.pipeline import IngestionPipeline, PipelineConfig


def test_per_tenant_sequence_is_isolated():
    pipe = IngestionPipeline(PipelineConfig(strict_sequence=True))
    pipe.ingest_one(
        {"event_id": "t1-1", "tenant_id": "t1", "seq_id": 1, "amount": "1.00", "occurred_at": "2026-11-01T00:00:00Z"},
        connector=conn_01.ingest,
    )
    pipe.ingest_one(
        {"event_id": "t1-2", "tenant_id": "t1", "seq_id": 2, "amount": "1.00", "occurred_at": "2026-11-01T00:01:00Z"},
        connector=conn_01.ingest,
    )
    # Different tenant starts at seq_id=1 independently
    r = pipe.ingest_one(
        {"event_id": "t2-1", "tenant_id": "t2", "seq_id": 1, "amount": "2.00", "occurred_at": "2026-11-01T00:02:00Z"},
        connector=conn_01.ingest,
    )
    assert r["tenant_id"] == "t2"
    with pytest.raises(SequenceError):
        pipe.ingest_one(
            {"event_id": "t1-bad", "tenant_id": "t1", "seq_id": 1, "amount": "1.00", "occurred_at": "2026-11-01T00:03:00Z"},
            connector=conn_01.ingest,
        )


def test_failed_ingest_allows_retry_and_rejects_conflict():
    pipe = IngestionPipeline(PipelineConfig(strict_sequence=True))
    boom = True

    def flaky(_env):
        if boom:
            raise RuntimeError("boom")

    pipe.register_hook(flaky)
    raw = {"event_id": "e-retry", "tenant_id": "t1", "seq_id": 1, "amount": "4.00", "occurred_at": "2026-11-01T00:00:00Z"}
    with pytest.raises(RuntimeError):
        pipe.ingest_one(raw, connector=conn_01.ingest)
    boom = False
    res = pipe.ingest_one(raw, connector=conn_01.ingest)
    assert res["status"] == "accepted"
    with pytest.raises(IdempotencyConflictError):
        pipe.ingest_one({**raw, "amount": "5.00"}, connector=conn_01.ingest)


@pytest.mark.parametrize("idx", range(40))
def test_retry_backoff_schedule_bulk(idx):
    pipe = IngestionPipeline()
    sched = pipe.estimate_retry_schedule()
    assert sched == [100, 200, 400, 800]
    assert pipe.tenant_count(f"missing-{idx}") == 0


@pytest.mark.parametrize("idx", range(40))
def test_pipeline_health_bulk(idx):
    pipe = IngestionPipeline()
    snap = pipe.health_snapshot()
    assert snap["accepted"] == 0
    assert snap["dlq_size"] == 0
    assert idx >= 0
''',
}

HIDDEN_TESTS = '''"""Applied only during grading: checks every requirement across all 16 connectors & invariants."""
from __future__ import annotations

import importlib
import inspect
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pytest

from chronos.core.errors import IdempotencyConflictError, ValidationError
from chronos.engine.pipeline import IngestionPipeline, PipelineConfig
from chronos.engine.reconcile import reconcile_tenant
from chronos.core.models import EventEnvelope


def test_shared_normalize_helper_exists_and_enforces_contract():
    from chronos.core.normalize import normalize_event

    env = normalize_event(
        {
            "event_id": "n-1",
            "tenant": "acme",
            "seq_id": 3,
            "amount": "1,234.565",
            "currency": "eur",
            "occurred_at": "2026-11-01 12:00:00",
            "metadata": None,
        },
        default_tz_offset_hours=2,
    )
    assert isinstance(env, EventEnvelope)
    assert env.tenant_id == "acme"
    assert env.currency == "EUR"
    assert env.amount == Decimal("1234.56")  # ROUND_HALF_EVEN
    assert env.occurred_at == datetime(2026, 11, 1, 10, 0, tzinfo=timezone.utc)
    assert env.metadata == {}

    cents_env = normalize_event(
        {
            "event_id": "n-2",
            "tenant_id": "acme",
            "seq_id": 4,
            "amount_cents": 2505,
            "occurred_at": "2026-11-01T10:00:00Z",
        },
        amount_is_cents=True,
    )
    assert cents_env.amount == Decimal("25.05")

    with pytest.raises(ValidationError):
        normalize_event(
            {
                "event_id": "n-bad",
                "tenant_id": "",
                "seq_id": 1,
                "amount": "1.00",
                "occurred_at": "2026-11-01T10:00:00Z",
            }
        )
    with pytest.raises(ValidationError):
        normalize_event(
            {
                "event_id": "n-bad2",
                "tenant_id": "acme",
                "seq_id": 1,
                "amount": "NaN",
                "occurred_at": "2026-11-01T10:00:00Z",
            }
        )


def test_all_16_connectors_migrated_and_no_private_copies():
    for n in range(1, 5):
        mod = importlib.import_module(f"chronos.connectors.conn_{n:02d}")
        src = inspect.getsource(mod)
        assert "def _clean_amount" not in src
        assert "def _parse_ts" not in src
        env = mod.ingest(
            {
                "event_id": f"e-{n}",
                "tenant": "t1",
                "seq_id": 1,
                "amount": "$10.10",
                "occurred_at": "2026-11-01T01:00:00Z",
            }
        )
        assert env.amount == Decimal("10.10")
        assert env.occurred_at.tzinfo == timezone.utc

    for n in range(5, 9):
        mod = importlib.import_module(f"chronos.connectors.conn_{n:02d}")
        src = inspect.getsource(mod)
        assert "def _clean_amount" not in src
        assert "def _parse_ts" not in src
        cls = getattr(mod, f"Connector{n:02d}")
        seen = []
        inst = cls(hook=seen.append)
        env = inst.transform(
            {
                "event_id": f"e-{n}",
                "tenant_id": "t2",
                "seq_id": 1,
                "amount": "20.20",
                "occurred_at": "2026-11-01T02:00:00+02:00",
            },
            ctx={"default_currency": "gbp"},
        )
        assert len(seen) == 1
        assert env.currency == "GBP"
        assert env.amount == Decimal("20.20")
        assert env.occurred_at.hour == 0

    for n in range(9, 13):
        mod = importlib.import_module(f"chronos.connectors.conn_{n:02d}")
        src = inspect.getsource(mod)
        assert "def _clean_amount" not in src
        assert "def _parse_ts" not in src
        env = mod.ingest(
            {
                "event_id": f"e-{n}",
                "tenant_id": "t3",
                "seq_id": 1,
                "amount_cents": 3035,
                "occurred_at": "2026-11-01T03:00:00Z",
            }
        )
        assert env.amount == Decimal("30.35")

    expected_offsets = {13: 2, 14: -5, 15: 9, 16: 0}
    for n in range(13, 17):
        mod = importlib.import_module(f"chronos.connectors.regional.conn_{n:02d}")
        src = inspect.getsource(mod)
        assert "def _clean_amount" not in src
        assert "def _parse_ts" not in src
        env = mod.ingest(
            {
                "event_id": f"e-{n}",
                "tenant_id": "t4",
                "seq_id": 1,
                "amount": "1,000.05",
                "occurred_at": "2026-11-01 12:00:00",
            }
        )
        assert env.amount == Decimal("1000.05")
        expected_utc = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc) - timedelta(hours=expected_offsets[n])
        assert env.occurred_at == expected_utc


def test_thousand_event_penny_precision_and_replay_strict():
    ts = datetime(2026, 11, 1, 0, 0, tzinfo=timezone.utc)
    events = [
        EventEnvelope(f"id-{i}", "big", i + 1, Decimal("0.10"), "USD", ts, kind="charge", metadata=None)  # type: ignore[arg-type]
        for i in range(1000)
    ]
    events.append(EventEnvelope("ref-1", "big", 1001, Decimal("0.50"), "USD", ts, kind="refund", metadata={}))
    rec = reconcile_tenant(events)
    assert rec["totals"]["USD"] == Decimal("99.50")

    repo_root = Path(__file__).resolve().parent.parent
    proc = subprocess.run(
        [sys.executable, "scripts/replay_incidents.py", "--strict"],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stdout[-1000:] + proc.stderr[-1000:]
'''


def main() -> int:
    if TARGET.exists():
        shutil.rmtree(TARGET)
    for rel, content in STATIC_FILES.items():
        dest = TARGET / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(content, encoding="utf-8")

    for n in range(1, 5):
        (TARGET / "chronos" / "connectors" / f"conn_{n:02d}.py").write_text(
            VARIANT_A.format(n=n), encoding="utf-8"
        )
    for n in range(5, 9):
        (TARGET / "chronos" / "connectors" / f"conn_{n:02d}.py").write_text(
            VARIANT_B.format(n=n), encoding="utf-8"
        )
    for n in range(9, 13):
        (TARGET / "chronos" / "connectors" / f"conn_{n:02d}.py").write_text(
            VARIANT_C.format(n=n), encoding="utf-8"
        )
    for n in range(13, 17):
        (TARGET / "chronos" / "connectors" / "regional" / f"conn_{n:02d}.py").write_text(
            VARIANT_D.format(n=n, offset=REGIONAL_OFFSETS[n]), encoding="utf-8"
        )

    for rel, content in VISIBLE_TESTS.items():
        dest = TARGET / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(content, encoding="utf-8")

    HIDDEN_DIR.mkdir(parents=True, exist_ok=True)
    (HIDDEN_DIR / "test_hard_hidden.py").write_text(HIDDEN_TESTS, encoding="utf-8")
    print(f"built {TARGET}")
    print(f"hidden tests: {HIDDEN_DIR / 'test_hard_hidden.py'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
