"""Job handler 06."""

from taskflow.core.models import Task


def make_slug(title: str) -> str:
    return title.strip().lower().replace(" ", "-")


def label_06(task: Task) -> str:
    return f"{make_slug(task.title)}-{task.priority}"


def summary_06(task: Task) -> str:
    return f"job06:{make_slug(task.title)}"
