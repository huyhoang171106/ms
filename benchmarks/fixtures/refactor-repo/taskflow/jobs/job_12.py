"""Job handler 12."""

from taskflow.core.models import Task


def make_slug(title: str) -> str:
    return title.strip().lower().replace(" ", "-")


def label_12(task: Task) -> str:
    return f"{make_slug(task.title)}-{task.priority}"


def summary_12(task: Task) -> str:
    return f"job12:{make_slug(task.title)}"
