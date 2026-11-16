"""Job handler 09."""

from taskflow.core.models import Task


def make_slug(title: str) -> str:
    return title.strip().lower().replace(" ", "-")


def label_09(task: Task) -> str:
    return f"{make_slug(task.title)}-{task.priority}"


def summary_09(task: Task) -> str:
    return f"job09:{make_slug(task.title)}"
