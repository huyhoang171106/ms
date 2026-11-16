"""Job handler 21."""

from taskflow.core.models import Task


def make_slug(title: str) -> str:
    return title.strip().lower().replace(" ", "-")


def label_21(task: Task) -> str:
    return f"{make_slug(task.title)}-{task.priority}"


def summary_21(task: Task) -> str:
    return f"job21:{make_slug(task.title)}"
