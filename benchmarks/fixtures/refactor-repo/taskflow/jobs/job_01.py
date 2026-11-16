"""Job handler 01."""

from taskflow.core.models import Task


def make_slug(title: str) -> str:
    return title.strip().lower().replace(" ", "-")


def label_01(task: Task) -> str:
    return f"{make_slug(task.title)}-{task.priority}"


def summary_01(task: Task) -> str:
    return f"job01:{make_slug(task.title)}"
