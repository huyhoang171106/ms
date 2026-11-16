"""Retry backoff calculation."""
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
