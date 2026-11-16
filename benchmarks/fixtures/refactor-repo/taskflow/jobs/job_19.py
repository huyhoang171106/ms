"""Job handler 19."""

from taskflow.core.models import Task


def make_slug(title: str) -> str:
    return title.strip().lower().replace(" ", "-")


def label_19(task: Task) -> str:
    return f"{make_slug(task.title)}-{task.priority}"


def summary_19(task: Task) -> str:
    return f"job19:{make_slug(task.title)}"
