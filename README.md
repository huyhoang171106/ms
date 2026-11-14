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

Run the NDJSON RPC server, MCP server, or Smart Command Distiller:

```bash
# NDJSON RPC server (Protocol v1)
./target/release/ms --root /path/to/workspace --state-dir /path/to/state --allow-write

# Universal MCP (JSON-RPC 2.0 over stdio) server for Claude Code, Pi, Cursor, etc.
./target/release/ms mcp --allow-write

# Smart Command Distiller + on-demand raw log inspection
./target/release/ms exec -- cargo test --workspace
./target/release/ms log --id <log_id> --tail 100 --grep error
```

## Axiom & Coding Agent Integration

Coding agents and orchestrators (such as Axiom) spawn `ms` as a subprocess and exchange NDJSON messages over `stdin`/`stdout` (with `stderr` reserved for sanitized operational diagnostics):

- **TypeScript / Axiom Adapter**: [`examples/axiom_adapter.ts`](examples/axiom_adapter.ts) — typed `MsClient` wrapper (`initialize`, `openSession`, `list`, `search`, `read`, `patch`, `txList`, `txUndo`, `cancel`, `closeSession`) with `operationId` idempotency and `deadlineMs`.
- **Python Client**: [`examples/python_client.py`](examples/python_client.py) — end-to-end NDJSON stdio example.
- See [`examples/README.md`](examples/README.md) for usage details.

## Verification & Benchmarks

- **Unit & Integration Tests**: `cargo test --workspace` — **26/26 passed** (`ms-protocol`: 8, `ms-runtime`: 11, `ms-rpc`: 4, `ms-cli`: 3).
- **E2E & Fault-Injection Suite** (`python3 tests/e2e/run_e2e.py`): **15/15 passed** against `target/release/ms` (covering T01–T16: traversal/symlink/FIFO/hardlink rejection, framing/cancellation, stale BLAKE3 revision & self-healing `E_CONFLICT`, `hashline` read & `edit`, `write_file`/`delete_file`/`rename_file` + `tx.undo`, `outline` & `context_bundle`, `ms exec` + `ms log`, and `ms mcp` stdio JSON-RPC 2.0).
- **Measured Token & Latency Wins** (see [`benchmarks/REPORT.md`](benchmarks/REPORT.md)):
  - `ms search` (warm): **3.94 ms** vs `rg` **6.46 ms**
  - `ms read` compact `hashline` (200 lines): **8,065 B (0.84 ms)** vs old JSON `24,210 B (1.50 ms)` (**66.7% smaller**)
  - `ms exec -- cargo test --workspace`: **2 lines / 136 B** vs raw **87 lines / 3,327 B** (**95.9% smaller**)
  - `ms exec -- git diff`: **83 lines / 4,409 B** vs raw **4,736 lines / 178,017 B** (**97.5% smaller**)
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
