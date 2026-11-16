"""Job handler 02."""

from taskflow.core.models import Task


def make_slug(title: str) -> str:
    return title.strip().lower().replace(" ", "-")


def label_02(task: Task) -> str:
    return f"{make_slug(task.title)}-{task.priority}"


def summary_02(task: Task) -> str:
    return f"job02:{make_slug(task.title)}"
