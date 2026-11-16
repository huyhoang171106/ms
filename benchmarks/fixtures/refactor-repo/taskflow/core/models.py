from dataclasses import dataclass, field
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
