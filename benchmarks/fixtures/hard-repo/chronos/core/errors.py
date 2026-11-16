"""Domain errors for Chronos."""


class ChronosError(Exception):
    """Base error."""


class ValidationError(ChronosError):
    """Raised when an event payload violates schema rules."""


class IdempotencyConflictError(ChronosError):
    """Raised when the same tenant+event_id is reused with a different payload."""


class SequenceError(ChronosError):
    """Raised when a tenant event arrives out of monotonic sequence order."""
