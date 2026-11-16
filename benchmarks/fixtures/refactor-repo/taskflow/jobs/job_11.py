"""Job handler 11."""

from taskflow.core.models import Task


def make_slug(title: str) -> str:
    return title.strip().lower().replace(" ", "-")


def label_11(task: Task) -> str:
    return f"{make_slug(task.title)}-{task.priority}"


def summary_11(task: Task) -> str:
    return f"job11:{make_slug(task.title)}"
