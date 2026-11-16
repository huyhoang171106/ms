"""Job handler 13."""

from taskflow.core.models import Task


def make_slug(title: str) -> str:
    return title.strip().lower().replace(" ", "-")


def label_13(task: Task) -> str:
    return f"{make_slug(task.title)}-{task.priority}"


def summary_13(task: Task) -> str:
    return f"job13:{make_slug(task.title)}"
