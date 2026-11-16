"""Idempotency and cache isolation tests."""
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
