"""Job handler 08."""

from taskflow.core.models import Task


def make_slug(title: str) -> str:
    return title.strip().lower().replace(" ", "-")


def label_08(task: Task) -> str:
    return f"{make_slug(task.title)}-{task.priority}"


def summary_08(task: Task) -> str:
    return f"job08:{make_slug(task.title)}"
