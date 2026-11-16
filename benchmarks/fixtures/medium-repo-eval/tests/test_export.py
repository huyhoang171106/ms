import pytest
from taskflow.core.models import Task
from taskflow.plugins.csv_export import export_tasks_csv


def test_csv_export_handles_none_metadata():
    tasks = [
        Task(id="1", title="Alpha", priority=2, metadata=None),
        Task(id="2", title="Beta", priority=1, metadata={"source": "cli"}),
    ]
    out = export_tasks_csv(tasks)
    assert "1,Alpha,2," in out
    assert "2,Beta,1,cli" in out


@pytest.mark.parametrize("n", range(40))
def test_task_summary_bulk(n):
    t = Task(id=f"s-{n}", title=f"Sum {n}", tags=["b", "a"])
    print(f"rendered summary for {t.id}: {t.summary()}")
    assert "a, b" in t.summary()
