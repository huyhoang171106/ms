"""Core data models."""
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
