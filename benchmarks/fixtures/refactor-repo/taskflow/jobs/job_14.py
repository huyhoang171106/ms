"""Job handler 14."""

from taskflow.core.models import Task


def make_slug(title: str) -> str:
    return title.strip().lower().replace(" ", "-")


def label_14(task: Task) -> str:
    return f"{make_slug(task.title)}-{task.priority}"


def summary_14(task: Task) -> str:
    return f"job14:{make_slug(task.title)}"
