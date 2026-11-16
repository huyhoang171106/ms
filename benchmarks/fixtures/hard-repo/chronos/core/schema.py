"""Event schema validation and v1->v2 upcasting."""
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
