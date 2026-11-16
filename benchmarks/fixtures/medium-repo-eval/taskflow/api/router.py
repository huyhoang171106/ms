from typing import Any, Dict, List
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
