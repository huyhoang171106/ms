from dataclasses import dataclass


@dataclass(frozen=True)
class RetryConfig:
    max_attempts: int = 3
    base_delay_ms: int = 100
    max_delay_ms: int = 1000
    jitter: bool = False
