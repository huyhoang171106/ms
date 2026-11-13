# ADR-08: Explicit Separation of Records and Bytes Streams

**Status:** Accepted

## Context
Implicitly heuristics-parsing stdout text into tables/JSON/CSV causes silent corruption and ambiguous types.

## Decision
`records` and `bytes` are distinct event payloads in Protocol v1. Record fields have fixed schemas (`OperationSchema`) with explicit types and nullability. Text-to-record codecs (`from-jsonl`, `from-lines`) are deferred to K4 as explicit operations.

## Consequences
- Zero implicit type coercion or heuristic table parsing.
