"""Legacy v1 compatibility helpers (DECOY - keep intact for v1 callers)."""
from __future__ import annotations


def legacy_clean_amount(value: object) -> float:
    """Deprecated v1 float helper kept for backwards compatibility tests."""
    return round(float(str(value).replace("$", "").strip()), 2)


def legacy_tag_line(tags: list[str] | None) -> str:
    return ",".join(sorted(tags or []))
