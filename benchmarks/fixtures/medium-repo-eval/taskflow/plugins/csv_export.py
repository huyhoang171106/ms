import csv
import io
from typing import Iterable
from taskflow.core.models import Task


def export_tasks_csv(tasks: Iterable[Task]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(["id", "title", "priority", "source"])
    for t in tasks:
        # BUG med-03: crashes with AttributeError when t.metadata is None
        source = t.metadata.get("source", "")
        writer.writerow([t.id, t.title, str(t.priority), source])
    return buf.getvalue()
