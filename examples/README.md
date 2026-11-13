# `ms` Client & Agent Adapter Examples

This directory contains integration examples for Protocol v1 (`ms`) over NDJSON `stdin`/`stdout`:

- [`python_client.py`](./python_client.py): Zero-dependency Python 3 client demonstrating `initialize` -> `session.open` -> `list` / `search` / `read` -> `session.close` against the `ms` binary.
- [`axiom_adapter.ts`](./axiom_adapter.ts): Typed TypeScript/Node adapter illustrating how Axiom's `ToolRegistry` wraps `ms` operations (`read`, `search`, `patch`, `tx.list`, `tx.undo`) with capability inspection, role-based narrowing, deadlines, cancellation, and idempotency keys (`operationId`).

## Quick Run (Python)

```bash
cargo build --release
python3 examples/python_client.py --ms-bin ./target/release/ms --root .
```
