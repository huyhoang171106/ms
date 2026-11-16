from taskflow.core.config import RetryConfig


def compute_backoff_ms(attempt: int, cfg: RetryConfig) -> int:
    """Return exponential backoff capped at cfg.max_delay_ms."""
    if attempt <= 0:
        return 0
    raw = cfg.base_delay_ms * (2 ** (attempt - 1))
    # BUG med-02: uses min? No, accidentally uses max instead of min, ignoring cap!
    return max(raw, cfg.max_delay_ms)
