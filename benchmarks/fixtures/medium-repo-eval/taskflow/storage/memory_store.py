from typing import Dict, List, Optional
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
