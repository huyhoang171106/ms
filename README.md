# ms — Structured Shell Runtime for Coding Agents

`ms` is a standalone, Linux-first Rust runtime providing a structured NDJSON-over-stdio RPC for coding agents to **list, search, read, patch, and durably undo** files in a managed workspace without shell quoting, terminal table parsing, or unguarded writes.

## Architecture

Four-crate workspace with strict dependency direction:

```text
ms-cli ──▶ ms-rpc ──▶ ms-runtime ──▶ ms-protocol
   └──────────────────▶ ms-runtime
```

- **`crates/ms-protocol`**: Pure DTOs, Protocol v1 NDJSON request/event envelopes, `ErrorCode`, capabilities, hard limits, and operation schemas. Zero filesystem or process dependencies.
- **`crates/ms-runtime`**: `WorkspaceFs` (root directory FD + `openat2` `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS`), host capability enforcement, bounded `list`/`search`/`read`/`patch`, single-writer `flock` workspace lease keyed by `(dev, ino)`, durable write-ahead journal, crash recovery, `operationId` idempotency, and conflict-aware `tx.undo`.
- **`crates/ms-rpc`**: NDJSON stdio framing (1 MiB max frame), concurrent `tokio` dispatcher with non-blocking `cancel`, bounded channels/backpressure, output quotas, and guaranteed `completed` terminal events.
- **`crates/ms-cli`**: Host configuration (CLI flags / `--config <JSON>`), `ms` binary entrypoint.

## Quick Start

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --release
```

Run the server over stdio:

```bash
./target/release/ms --root /path/to/workspace --state-dir /path/to/state --allow-write
```

## Axiom & Coding Agent Integration

Coding agents and orchestrators (such as Axiom) spawn `ms` as a subprocess and exchange NDJSON messages over `stdin`/`stdout` (with `stderr` reserved for sanitized operational diagnostics):

- **TypeScript / Axiom Adapter**: [`examples/axiom_adapter.ts`](examples/axiom_adapter.ts) — typed `MsClient` wrapper (`initialize`, `openSession`, `list`, `search`, `read`, `patch`, `txList`, `txUndo`, `cancel`, `closeSession`) with `operationId` idempotency and `deadlineMs`.
- **Python Client**: [`examples/python_client.py`](examples/python_client.py) — end-to-end NDJSON stdio example.
- See [`examples/README.md`](examples/README.md) for usage details.

## Verification & Benchmarks (MVP K2)

- **Unit & Integration Tests**: `cargo test --workspace` — **25/25 passed** (`ms-protocol`: 8, `ms-runtime`: 10, `ms-rpc`: 4, `ms-cli`: 3).
- **E2E & Fault-Injection Suite** (`python3 tests/e2e/run_e2e.py`): **12/12 passed** against `target/release/ms` (covering T01–T13b: traversal/symlink/FIFO/hardlink rejection, framing/cancellation, stale BLAKE3 revision `E_CONFLICT`, CRLF/BOM/Unicode preservation, `SIGKILL` crash recovery, `tx.undo` / `E_UNDO_CONFLICT`, `operationId` deduplication, and single-writer workspace lease).
- **Benchmarks** ([`benchmarks/REPORT.md`](benchmarks/REPORT.md), [`benchmarks/results.json`](benchmarks/results.json)):
  - `list_large_repo_501_files`: `ms` warm 2.904 ms (7148 KB RSS) vs `fdfind` 5.945 ms (5252 KB RSS)
  - `read_bounded_20_lines`: `ms` warm 0.238 ms (5152 KB RSS) vs `python3` 21.090 ms (12236 KB RSS)
  - `read_plus_patch_small_repo`: `ms` cold 4.492 ms (5208 KB RSS, with BLAKE3 + journal + atomic rename) vs `python3` 19.667 ms (12132 KB RSS)

## Documentation

- [Protocol v1 Specification](docs/protocol-v1.md)
- [Threat Model](docs/threat-model.md)
- [Architecture Decision Records (ADR-01..10)](docs/adr/)

## Scope & Guarantees (MVP K2)

- **Linux-first**: Relies on `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)` and `fsync` semantics; fails closed if unsupported.
- **Single-file atomic + durable transactions**: Preimage + `PREPARED` journal + temp file in target directory + `fsync` + revalidate + atomic `rename` + dir `fsync` + `COMMITTED`.
- **Cooperative single-writer lock**: Keyed by root `(dev, ino)` in host-managed `state_dir` (`0700`). Does not prevent concurrent external editors outside `ms`, though full BLAKE3 `expectedRevision` detects external modifications before commit.
- **No arbitrary shell execution** in K1/K2 MVP (`allowExternalExec: false`).
