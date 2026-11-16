"""Job handler 07."""

from taskflow.core.models import Task


def make_slug(title: str) -> str:
    return title.strip().lower().replace(" ", "-")


def label_07(task: Task) -> str:
    return f"{make_slug(task.title)}-{task.priority}"


def summary_07(task: Task) -> str:
    return f"job07:{make_slug(task.title)}"
