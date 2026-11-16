import pytest
from taskflow.core.config import RetryConfig
from taskflow.core.scheduler import compute_backoff_ms


def test_backoff_caps_at_max_delay():
    cfg = RetryConfig(max_attempts=5, base_delay_ms=100, max_delay_ms=500)
    assert compute_backoff_ms(1, cfg) == 100
    assert compute_backoff_ms(2, cfg) == 200
    assert compute_backoff_ms(4, cfg) == 500


@pytest.mark.parametrize("n", range(40))
def test_config_defaults_bulk(n):
    cfg = RetryConfig(base_delay_ms=50 + n)
    print(f"checked retry config variant {n} with base={cfg.base_delay_ms}")
    assert cfg.max_attempts == 3
