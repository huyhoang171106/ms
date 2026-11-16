def validate_title(title: str) -> str:
    cleaned = (title or "").strip()
    if not cleaned:
        raise ValueError("Task title must not be empty")
    return cleaned
