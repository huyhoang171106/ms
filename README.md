# ms — Structured Shell & File Runtime for Coding Agents

`ms` is a standalone, Linux-first Rust runtime providing a structured NDJSON-over-stdio RPC, an MCP JSON-RPC 2.0 stdio server, and a smart command distiller (`ms exec` / `ms log`) for coding agents to **list, search, read, outline, edit, batch-patch, and durably undo** files in a managed workspace without shell quoting, terminal table parsing, or unguarded writes.

## Architecture

Four-crate workspace with strict dependency direction:

```text
ms-cli ──▶ ms-rpc ──▶ ms-runtime ──▶ ms-protocol
   └──────────────────▶ ms-runtime
```

- **`crates/ms-protocol`**: Pure DTOs, Protocol v1 NDJSON request/event envelopes, `ErrorCode`, capabilities, hard limits, and operation schemas. Zero filesystem or process dependencies.
- **`crates/ms-runtime`**: `WorkspaceFs` (root directory FD + `openat2` `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS`), host capability enforcement, bounded `list`/`search`/`read` (with compact `hashline`), `outline`, `context_bundle`, `patch`, `edit` (line-range / `oldText` / byte-range + self-healing `E_CONFLICT`), `write_file`, `delete_file`, `rename_file`, atomic `patch.batch` (with rollback and batch-level `operationId` idempotency), single-writer `flock` workspace lease keyed by `(dev, ino)`, durable write-ahead journal, crash recovery, and conflict-aware `tx.undo`.
- **`crates/ms-rpc`**: NDJSON stdio framing (1 MiB max frame), concurrent `tokio` dispatcher with non-blocking `cancel`, bounded channels/backpressure, output quotas, guaranteed `completed` terminal events, `ms mcp` (MCP JSON-RPC 2.0 over stdio), and `ms exec` / `ms log` (smart command distiller with failure context snippets and automatic `/tmp/ms-logs` TTL/count GC).
- **`crates/ms-cli`**: Host configuration (CLI flags / `--config <JSON>`), `ms` binary entrypoint (`serve`, `mcp`, `exec`, `log`).

## Quick Start

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --release
```

Run the NDJSON RPC server, MCP server, or Smart Command Distiller:

```bash
# NDJSON RPC server (Protocol v1)
./target/release/ms --root /path/to/workspace --state-dir /path/to/state --allow-write

# Universal MCP (JSON-RPC 2.0 over stdio) server for Claude Code, Pi, Cursor, Antigravity
./target/release/ms mcp --root /path/to/workspace --allow-write --state-dir /path/to/state

# Smart Command Distiller + on-demand raw log inspection
./target/release/ms exec -- cargo test --workspace
./target/release/ms log --id <log_id> --tail 100 --grep error
```

### One-Command MCP Integration Installer

Wire `ms mcp` into Pi (`~/.pi/agent/mcp.json`) and/or Claude Code (`~/.claude.json`) safely (creates timestamped backups of existing configs and preserves all other keys):

```bash
bash scripts/install_integrations.sh --dry-run --all
bash scripts/install_integrations.sh --all        # or --pi / --claude
```

## Axiom & Coding Agent Integration

Coding agents and orchestrators (such as Axiom) spawn `ms` as a subprocess or use the typed adapter:

- **TypeScript / Axiom Adapter**: [`examples/axiom_adapter.ts`](examples/axiom_adapter.ts) — typed `MsClient` and `MsAxiomAdapter` (preserving `test-guard` protections, in-process `exec` + `readLog`, `hashline` snippets, and `operationId` idempotency).
- **Python Client**: [`examples/python_client.py`](examples/python_client.py) — end-to-end NDJSON stdio example.
- **Single Axiom Tool (code mode)**: [`integrations/axiom/`](integrations/axiom/README.md) — replaces Axiom's eight file/shell tools with one `ms` tool that runs a JavaScript program on this runtime (**−48.7%** tool-definition bytes, 1 call instead of 4), keeping revision checks, atomic batches, durable undo, the test-guard and distilled output. Check: `bun integrations/axiom/selftest.ts`.
- **Python REPL as the only tool, EXPERIMENTAL**: [`integrations/axiom/cpy-cli.ts`](integrations/axiom/README.md#c_py-python-repl-as-the-only-tool-experimental) runs an Axiom agent whose only tool is a persistent CPython REPL (the Terminal-Bench C_py arm). Model code runs unsandboxed as you.
- See [`examples/README.md`](examples/README.md) for usage details.

## Verification & Benchmarks

- **Unit & Integration Tests** (`cargo test --workspace`): **42/42 passed** (`ms-cli`: 3, `ms-protocol`: 8, `ms-rpc`: 16, `ms-runtime`: 15 — including `patch.batch` atomic rollback, batch-level idempotency/conflict, rollback-retry, and epoch expiry tests).
- **E2E & Fault-Injection Suite** (`python3 tests/e2e/run_e2e.py`): **15/15 passed** against `target/release/ms` (covering T01–T16: traversal/symlink/FIFO/hardlink rejection, framing/cancellation, stale BLAKE3 revision & self-healing `E_CONFLICT`, `hashline` read & `edit`, `write_file`/`delete_file`/`rename_file` + `tx.undo`, `outline` & `context_bundle`, `ms exec` + `ms log`, and `ms mcp` stdio JSON-RPC 2.0).
- **MCP E2E Suite** (`python3 tests/e2e/test_mcp_e2e.py`): **passed** against `target/release/ms mcp` (initialize, tools/list, read/edit/patch.batch/exec/log/undo over JSON-RPC 2.0 stdio).
- **Axiom Adapter & Harness Tests** (`bun test benchmarks/ab_axiom_uc01.test.ts`): **29/29 passed** (223 assertions).
- **Measured Token & Latency Wins** ([`benchmarks/REPORT.md`](benchmarks/REPORT.md), [`benchmarks/results.json`](benchmarks/results.json)):
  - `ms search` (warm): **3.94 ms** vs `rg` **6.46 ms**
  - `ms read` compact `hashline` (200 lines): **8,065 B (0.84 ms)** vs old JSON `24,210 B (1.50 ms)` (**66.7% smaller**)
  - `ms exec -- cargo test --workspace`: **2 lines / 136 B** vs raw **87 lines / 3,327 B** (**95.9% smaller**)
  - `ms exec -- git diff`: **83 lines / 4,409 B** vs raw **4,736 lines / 178,017 B** (**97.5% smaller**)
  - `list_large_repo_501_files`: `ms` warm **2.904 ms** vs `fdfind` **5.945 ms**
  - `read_bounded_20_lines`: `ms` warm **0.238 ms** vs `python3` **21.090 ms**
  - `read_plus_patch_small_repo`: `ms` cold **4.492 ms** (with BLAKE3 + journal + atomic rename) vs `python3` **19.667 ms**
- **Controlled Agent A/B Evaluations** (honest findings on `evals/uc01/`):
  - [`benchmarks/AB_SINGLE_TOOL_REPORT.md`](benchmarks/AB_SINGLE_TOOL_REPORT.md) — eight Axiom tools vs one `ms` tool, both arms 100% verified pass:
    - `claude-haiku-5-5`, `--trials 10` = **30 pairs / 60 runs**: tool calls **-51.7%** (`95% CI [-55.6%, -47.5%]`, worse in 0/30 pairs), LLM turns **-13.7%** (`CI [-20.7%, -6.4%]`), **total tokens flat `+3.9%` (`CI [-3.6%, +11.3%]`)** and tool output bytes **`+32.3%` (`CI [+15.4%, +49.3%]`, i.e. larger single results)**. Honest claim: half the round trips, ~14% fewer turns, **no token or cost win** on this fixture.
    - `deepseek-v4-1-flash`, `--trials 3` = 9 pairs: tool calls `-50.9%` (`CI [-56.4%, -45.0%]`, 9/9 pairs), turns `-21.2%` (`CI [-31.2%, -9.7%]`), wall `-9.1%` (`CI [-15.3%, -1.9%]`).
  - 30-pair follow-up (`claude-haiku-5-5`, `--trials 10`, 60 runs, 60/60 verified pass, 0 infra errors): the pre-collapse design where `ms` was registered as 10 separate tools was **neutral to worse** than Axiom's eight — turns `+1.9%` (`CI [-4.8%, +9.4%]`), tool calls `+6.1%`, wall clock `+19.5%` (`CI [+7.5%, +32.8%]`, i.e. significantly slower). The `N=1` byte and cost savings above did not replicate at 30 pairs.
  - Re-analyze any stored artifact without spending API tokens: `python3 benchmarks/paired_bootstrap.py benchmarks/artifacts/<dir>` (paired bootstrap CI + exact sign test; `--selftest` checks the statistics).
  - [`benchmarks/AB_AXIOM_REPORT.md`](benchmarks/AB_AXIOM_REPORT.md) (`claude-haiku-5-5`, `N=1` smoke): **3/3** verified pass in both arms; `-60.5%` tool output bytes (`9,659 B` vs `24,424 B`), `+53.7%` estimated cost in smoke run due to extra tool turns.
  - [`benchmarks/AB_DEEPSEEK_WEAKNESS_REPORT.md`](benchmarks/AB_DEEPSEEK_WEAKNESS_REPORT.md) (`deepseek-v4-1-flash`, `N=3` paired = 18 runs): **9/9 (100%)** verified pass in both arms; `-51.7%` tool output bytes and `-11.7%` total tokens (`550,334` vs `622,966`), `0%` edit errors (`17/17` vs `13.3%` malformed diffs in baseline), while identifying areas improved in subsequent work (`..` path normalization, read-only `ms exec` false positives, `readLog` + GC, and `patch.batch` idempotency).

## Documentation

- [Protocol v1 Specification](docs/protocol-v1.md)
- [Threat Model](docs/threat-model.md)
- [Architecture Decision Records (ADR-01..10)](docs/adr/)

## Scope & Guarantees

- **Linux-first**: Relies on `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)` and `fsync` semantics; fails closed if unsupported.
- **Single-file & batch atomic transactions**: Preimage + `PREPARED` journal + temp file in target directory + `fsync` + revalidate + atomic `rename` + dir `fsync` + `COMMITTED` (with automatic reverse-order rollback on `patch.batch` mid-batch failure and `BatchCommitted` idempotency records).
- **Cooperative single-writer lock**: Keyed by root `(dev, ino)` in host-managed `state_dir` (`0700`). Full BLAKE3 `expectedRevision` detects external modifications before commit.
- **No arbitrary shell execution over Protocol v1 RPC** (`allowExternalExec: false`); `ms exec` is an explicit CLI subcommand / MCP opt-in tool for distilled command execution with `/tmp/ms-logs` GC.
