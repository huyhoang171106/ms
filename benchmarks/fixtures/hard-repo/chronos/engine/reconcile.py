"""Batch ledger reconciliation."""
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
