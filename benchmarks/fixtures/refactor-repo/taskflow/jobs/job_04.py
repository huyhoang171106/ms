"""Job handler 04."""

from taskflow.core.models import Task


def make_slug(title: str) -> str:
    return title.strip().lower().replace(" ", "-")


def label_04(task: Task) -> str:
    return f"{make_slug(task.title)}-{task.priority}"


def summary_04(task: Task) -> str:
    return f"job04:{make_slug(task.title)}"
