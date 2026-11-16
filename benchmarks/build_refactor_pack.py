#!/usr/bin/env python3
"""Builds benchmarks/fixtures/refactor-repo: 24 job modules that each carry their own copy of make_slug().

The task is one mechanical migration over 24 files, which is the workload where a tool list and a code-mode
program diverge most: 24 read+edit round trips against one program that greps, rewrites and verifies.

Idempotent: wipes and rebuilds the fixture from benchmarks/fixtures/medium-repo-eval.
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "fixtures" / "medium-repo-eval"
TARGET = ROOT / "fixtures" / "refactor-repo"
MODULES = 24

JOB_MODULE = '''"""Job handler {n:02d}."""

from taskflow.core.models import Task


def make_slug(title: str) -> str:
    return title.strip().lower().replace(" ", "-")


def label_{n:02d}(task: Task) -> str:
    return f"{{make_slug(task.title)}}-{{task.priority}}"


def summary_{n:02d}(task: Task) -> str:
    return f"job{n:02d}:{{make_slug(task.title)}}"
'''

VISIBLE_TESTS = '''"""Job handlers and the slug they render."""

import pytest
from taskflow.core.models import Task
from taskflow.jobs import job_01, job_02, job_24


def test_label_uses_slug():
    assert job_01.label_01(Task(id="1", title="Hello World", priority=2)) == "hello-world-2"


def test_summary_uses_slug():
    assert job_24.summary_24(Task(id="24", title="Ship It")) == "job24:ship-it"


def test_every_job_module_is_wired():
    import importlib

    for n in range(1, 25):
        module = importlib.import_module(f"taskflow.jobs.job_{n:02d}")
        task = Task(id=str(n), title=f"Task {n}", priority=n)
        assert getattr(module, f"label_{n:02d}")(task) == f"task-{n}-{n}"


@pytest.mark.parametrize("n", range(40))
@pytest.mark.parametrize("priority", [1, 5])
@pytest.mark.parametrize("title", ["a b", "One Item"])

def test_label_bulk(n, priority, title):
    task = Task(id=f"b-{n}", title=title, priority=priority)
    assert job_02.label_02(task) == f"{title.lower().replace(' ', '-')}-{priority}"
'''

HIDDEN_TESTS = '''"""Applied after the run: the behaviour the migration promise has to hold, wherever it is called from."""

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
        ("a  b\tc", "a-b-c"),
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
'''


def main() -> int:
    if not SOURCE.is_dir():
        print(f"missing source fixture: {SOURCE}")
        return 1
    if TARGET.exists():
        shutil.rmtree(TARGET)
    shutil.copytree(SOURCE, TARGET)

    jobs = TARGET / "taskflow" / "jobs"
    jobs.mkdir()
    (jobs / "__init__.py").write_text("")
    for n in range(1, MODULES + 1):
        (jobs / f"job_{n:02d}.py").write_text(JOB_MODULE.format(n=n))
    (TARGET / "tests" / "test_jobs.py").write_text(VISIBLE_TESTS)

    # Kept outside the fixture: the agent must not be able to read, adapt to, or weaken these.
    hidden_dir = ROOT / "hidden"
    hidden_dir.mkdir(exist_ok=True)
    (hidden_dir / "test_slugs_hidden.py").write_text(HIDDEN_TESTS)

    print(f"built {TARGET} with {MODULES} job modules")
    print(f"hidden tests: {hidden_dir / 'test_slugs_hidden.py'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
