"""Job handler 03."""

from taskflow.core.models import Task


def make_slug(title: str) -> str:
    return title.strip().lower().replace(" ", "-")


def label_03(task: Task) -> str:
    return f"{make_slug(task.title)}-{task.priority}"


def summary_03(task: Task) -> str:
    return f"job03:{make_slug(task.title)}"
