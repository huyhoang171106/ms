# ADR-03: Four-Crate Workspace Layout

**Status:** Accepted

## Context
Over-splitting into 7+ crates early adds boilerplate without clear boundaries.

## Decision
Start with four crates:
1. `ms-protocol` — pure DTOs, limits, error codes, schemas (zero FS/process deps).
2. `ms-runtime` — `WorkspaceFs`, policy, builtins, edit engine, durable journal, recovery.
3. `ms-rpc` — NDJSON stdio framing, concurrent `tokio` dispatcher, cancellation, backpressure.
4. `ms-cli` — host configuration and `ms` binary entrypoint.

## Consequences
- Clean one-way dependency graph (`ms-cli -> ms-rpc -> ms-runtime -> ms-protocol`).
- `ms-protocol` stays lightweight and free of runtime side effects.
