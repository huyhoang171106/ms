from typing import List, Sequence, TypeVar

T = TypeVar("T")


def paginate_items(items: Sequence[T], page: int, page_size: int) -> List[T]:
    """Return 1-based page slice of items."""
    if page < 1 or page_size < 1:
        raise ValueError("page and page_size must be >= 1")
    # BUG med-01: off-by-one uses `page * page_size` instead of `(page - 1) * page_size`
    start = page * page_size
    end = start + page_size
    return list(items[start:end])
