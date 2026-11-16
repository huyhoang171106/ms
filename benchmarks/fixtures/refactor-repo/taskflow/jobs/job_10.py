"""Job handler 10."""

from taskflow.core.models import Task


def make_slug(title: str) -> str:
    return title.strip().lower().replace(" ", "-")


def label_10(task: Task) -> str:
    return f"{make_slug(task.title)}-{task.priority}"


def summary_10(task: Task) -> str:
    return f"job10:{make_slug(task.title)}"
