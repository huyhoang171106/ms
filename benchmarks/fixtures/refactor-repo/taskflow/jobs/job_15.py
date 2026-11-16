"""Job handler 15."""

from taskflow.core.models import Task


def make_slug(title: str) -> str:
    return title.strip().lower().replace(" ", "-")


def label_15(task: Task) -> str:
    return f"{make_slug(task.title)}-{task.priority}"


def summary_15(task: Task) -> str:
    return f"job15:{make_slug(task.title)}"
