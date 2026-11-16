"""Job handler 23."""

from taskflow.core.models import Task


def make_slug(title: str) -> str:
    return title.strip().lower().replace(" ", "-")


def label_23(task: Task) -> str:
    return f"{make_slug(task.title)}-{task.priority}"


def summary_23(task: Task) -> str:
    return f"job23:{make_slug(task.title)}"
