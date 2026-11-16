#!/usr/bin/env python3
"""Generate deterministic 36-file Python fixture for medium-repo-eval A/B benchmark."""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent / "fixtures" / "medium-repo-eval"

MODULES = {
    "taskflow/__init__.py": '"""TaskFlow package."""\n__version__ = "0.4.0"\n',
    "taskflow/core/__init__.py": "",
    "taskflow/core/models.py": '''from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class Task:
    id: str
    title: str
    priority: int = 1
    tags: List[str] = field(default_factory=list)
    metadata: Optional[Dict[str, Any]] = None
    completed: bool = False

    def summary(self) -> str:
        tag_str = ", ".join(sorted(self.tags)) if self.tags else "none"
        return f"[{self.id}] {self.title} (p={self.priority}, tags={tag_str})"
''',
    "taskflow/core/config.py": '''from dataclasses import dataclass


@dataclass(frozen=True)
class RetryConfig:
    max_attempts: int = 3
    base_delay_ms: int = 100
    max_delay_ms: int = 1000
    jitter: bool = False
''',
    "taskflow/core/scheduler.py": '''from taskflow.core.config import RetryConfig


def compute_backoff_ms(attempt: int, cfg: RetryConfig) -> int:
    """Return exponential backoff capped at cfg.max_delay_ms."""
    if attempt <= 0:
        return 0
    raw = cfg.base_delay_ms * (2 ** (attempt - 1))
    # BUG med-02: uses min? No, accidentally uses max instead of min, ignoring cap!
    return max(raw, cfg.max_delay_ms)
''',
    "taskflow/core/validator.py": '''def validate_title(title: str) -> str:
    cleaned = (title or "").strip()
    if not cleaned:
        raise ValueError("Task title must not be empty")
    return cleaned
''',
    "taskflow/storage/__init__.py": "",
    "taskflow/storage/query.py": '''from typing import List, Sequence, TypeVar

T = TypeVar("T")


def paginate_items(items: Sequence[T], page: int, page_size: int) -> List[T]:
    """Return 1-based page slice of items."""
    if page < 1 or page_size < 1:
        raise ValueError("page and page_size must be >= 1")
    # BUG med-01: off-by-one uses `page * page_size` instead of `(page - 1) * page_size`
    start = page * page_size
    end = start + page_size
    return list(items[start:end])
''',
    "taskflow/storage/memory_store.py": '''from typing import Dict, List, Optional
from taskflow.core.models import Task


class MemoryStore:
    def __init__(self) -> None:
        self._items: Dict[str, Task] = {}

    def put(self, task: Task) -> None:
        self._items[task.id] = task

    def get(self, task_id: str) -> Optional[Task]:
        return self._items.get(task_id)

    def list_all(self) -> List[Task]:
        return [self._items[k] for k in sorted(self._items)]
''',
    "taskflow/api/__init__.py": "",
    "taskflow/api/router.py": '''from typing import Any, Dict, List
from taskflow.storage.memory_store import MemoryStore
from taskflow.storage.query import paginate_items


def handle_list_tasks(store: MemoryStore, page: int = 1, page_size: int = 10) -> Dict[str, Any]:
    all_tasks = store.list_all()
    page_items = paginate_items(all_tasks, page=page, page_size=page_size)
    return {
        "page": page,
        "page_size": page_size,
        "total": len(all_tasks),
        "items": [t.id for t in page_items],
    }
''',
    "taskflow/plugins/__init__.py": "",
    "taskflow/plugins/csv_export.py": '''import csv
import io
from typing import Iterable
from taskflow.core.models import Task


def export_tasks_csv(tasks: Iterable[Task]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\\n")
    writer.writerow(["id", "title", "priority", "source"])
    for t in tasks:
        # BUG med-03: crashes with AttributeError when t.metadata is None
        source = t.metadata.get("source", "")
        writer.writerow([t.id, t.title, str(t.priority), source])
    return buf.getvalue()
''',
}

# Add 18 realistic auxiliary domain/service/util modules so repo has 36 files total
AUX_NAMES = [
    "core/events", "core/metrics", "core/errors", "core/hooks", "core/context",
    "storage/serializer", "storage/index", "storage/cache", "storage/snapshot",
    "api/auth", "api/middleware", "api/rate_limit", "api/health",
    "cli/commands", "cli/formatter", "cli/args",
    "plugins/json_export", "plugins/webhook",
]

TESTS = {
    "tests/test_api_pagination.py": '''import pytest
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
''',
    "tests/test_scheduler.py": '''import pytest
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
''',
    "tests/test_export.py": '''import pytest
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
''',
}


def main() -> None:
    if ROOT.exists():
        shutil.rmtree(ROOT)
    for rel, content in {**MODULES, **TESTS}.items():
        p = ROOT / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")

    for aux in AUX_NAMES:
        p = ROOT / "taskflow" / f"{aux}.py"
        p.parent.mkdir(parents=True, exist_ok=True)
        mod_name = aux.replace("/", "_")
        p.write_text(
            f'"""Auxiliary module {aux}."""\n\n\n'
            f'def {mod_name}_status() -> str:\n'
            f'    return "{mod_name}:ok"\n',
            encoding="utf-8",
        )
    (ROOT / "README.md").write_text(
        "# TaskFlow\n\nRun tests with `python3 -m pytest`.\n",
        encoding="utf-8",
    )
    (ROOT / "pytest.ini").write_text("[pytest]\naddopts = -s\n", encoding="utf-8")
    total_files = sum(1 for _ in ROOT.rglob("*") if _.is_file())
    print(f"Generated medium-repo-eval fixture at {ROOT} ({total_files} files)")


if __name__ == "__main__":
    main()
