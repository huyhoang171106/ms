"""Time-window filtering for UTC ledger intervals."""
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
