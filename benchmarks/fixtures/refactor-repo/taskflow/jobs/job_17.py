"""Job handler 17."""

from taskflow.core.models import Task


def make_slug(title: str) -> str:
    return title.strip().lower().replace(" ", "-")


def label_17(task: Task) -> str:
    return f"{make_slug(task.title)}-{task.priority}"


def summary_17(task: Task) -> str:
    return f"job17:{make_slug(task.title)}"
