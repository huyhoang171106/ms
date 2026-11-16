"""Job handler 22."""

from taskflow.core.models import Task


def make_slug(title: str) -> str:
    return title.strip().lower().replace(" ", "-")


def label_22(task: Task) -> str:
    return f"{make_slug(task.title)}-{task.priority}"


def summary_22(task: Task) -> str:
    return f"job22:{make_slug(task.title)}"
