"""End-to-end pipeline and bulk baseline tests (keep all green)."""
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
