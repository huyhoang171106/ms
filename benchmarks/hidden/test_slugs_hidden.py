"""Applied after the run: the behaviour the migration promise has to hold, wherever it is called from."""

import pytest
from taskflow.core.models import Task


def test_shared_helper_exists():
    from taskflow.core.slugs import make_slug

    assert callable(make_slug)


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("Hello World", "hello-world"),
        ("  Hello   World  ", "hello-world"),
        ("--Hello--", "hello"),
        ("Hello, World!", "hello-world"),
        ("a  b	c", "a-b-c"),
        ("", ""),
        ("   ", ""),
        ("Café Ünïcode", "caf-n-code"),
        ("v1.2.3", "v1-2-3"),
    ],
)
def test_make_slug_rules(raw, expected):
    from taskflow.core.slugs import make_slug

    assert make_slug(raw) == expected


def test_no_job_module_keeps_a_private_copy():
    import importlib
    import inspect

    for n in range(1, 25):
        module = importlib.import_module(f"taskflow.jobs.job_{n:02d}")
        # Importing the shared helper is the point; defining a local one is the duplication being removed.
        assert "def make_slug" not in inspect.getsource(module), f"job_{n:02d} still defines its own make_slug"
        assert getattr(module, f"label_{n:02d}")(Task(id="x", title="Two  Words", priority=1)) == "two-words-1"
        assert getattr(module, f"summary_{n:02d}")(Task(id="x", title="Two  Words")) == f"job{n:02d}:two-words"
