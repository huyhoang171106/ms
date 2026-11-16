import pytest
from taskflow.core.models import Task
from taskflow.storage.memory_store import MemoryStore
from taskflow.api.router import handle_list_tasks


def _seed_store(n=25):
    s = MemoryStore()
    for i in range(1, n + 1):
        s.put(Task(id=f"t-{i:02d}", title=f"Task {i}"))
    return s


def test_pagination_first_page():
    s = _seed_store(25)
    res = handle_list_tasks(s, page=1, page_size=10)
    assert res["items"] == [f"t-{i:02d}" for i in range(1, 11)]


def test_pagination_second_page():
    s = _seed_store(25)
    res = handle_list_tasks(s, page=2, page_size=10)
    assert res["items"] == [f"t-{i:02d}" for i in range(11, 21)]


@pytest.mark.parametrize("idx", range(40))
def test_store_put_get_bulk(idx):
    s = MemoryStore()
    t = Task(id=f"bulk-{idx}", title=f"Bulk {idx}")
    s.put(t)
    print(f"verified bulk item {idx} successfully in store")
    assert s.get(f"bulk-{idx}") == t
