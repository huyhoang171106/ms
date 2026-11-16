"""Job handler 16."""

from taskflow.core.models import Task


def make_slug(title: str) -> str:
    return title.strip().lower().replace(" ", "-")


def label_16(task: Task) -> str:
    return f"{make_slug(task.title)}-{task.priority}"


def summary_16(task: Task) -> str:
    return f"job16:{make_slug(task.title)}"
