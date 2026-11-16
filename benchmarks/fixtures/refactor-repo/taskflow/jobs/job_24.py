"""Job handler 24."""

from taskflow.core.models import Task


def make_slug(title: str) -> str:
    return title.strip().lower().replace(" ", "-")


def label_24(task: Task) -> str:
    return f"{make_slug(task.title)}-{task.priority}"


def summary_24(task: Task) -> str:
    return f"job24:{make_slug(task.title)}"
