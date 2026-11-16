"""Job handler 05."""

from taskflow.core.models import Task


def make_slug(title: str) -> str:
    return title.strip().lower().replace(" ", "-")


def label_05(task: Task) -> str:
    return f"{make_slug(task.title)}-{task.priority}"


def summary_05(task: Task) -> str:
    return f"job05:{make_slug(task.title)}"
