"""Job handler 18."""

from taskflow.core.models import Task


def make_slug(title: str) -> str:
    return title.strip().lower().replace(" ", "-")


def label_18(task: Task) -> str:
    return f"{make_slug(task.title)}-{task.priority}"


def summary_18(task: Task) -> str:
    return f"job18:{make_slug(task.title)}"
