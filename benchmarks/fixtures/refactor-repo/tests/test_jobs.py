"""Job handlers and the slug they render."""

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
