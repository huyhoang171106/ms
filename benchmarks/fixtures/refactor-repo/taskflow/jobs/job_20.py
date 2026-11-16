"""Job handler 20."""

from taskflow.core.models import Task


def make_slug(title: str) -> str:
    return title.strip().lower().replace(" ", "-")


def label_20(task: Task) -> str:
    return f"{make_slug(task.title)}-{task.priority}"


def summary_20(task: Task) -> str:
    return f"job20:{make_slug(task.title)}"
