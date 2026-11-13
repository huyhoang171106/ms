# Threat Model (`ms` MVP K1/K2)

## 1. Assets & Trust Boundaries

- **Host**: Launches `ms` with CLI/config specifying `workspace_root`, `state_dir`, `allow_write`, deny rules, and `HardLimits`. **Trusted.**
- **Client (Coding Agent / Harness)**: Sends NDJSON requests over `stdin` and reads events from `stdout`. **Untrusted** with respect to path traversal, capability escalation, and resource exhaustion.
- **Workspace Filesystem**: Contains source files plus sensitive paths (`.git`, `.env`, credentials).
- **State Directory (`state_dir`)**: Host-managed directory outside the agent's writable workspace (`0700` dir, `0600` files) containing workspace locks, durable journal, and file preimages.

## 2. Threats & Mitigations

| ID | Threat | Mitigation |
|---|---|---|
| T-01 | **Path traversal / symlink escape** (`../`, `/etc/passwd`, symlinked parent or leaf, TOCTOU symlink swap) | `ms-protocol` rejects `..`, `/`, `\`, NUL, control chars. `ms-runtime` opens a root directory FD and resolves every component via `openat2` with `RESOLVE_BENEATH \| RESOLVE_NO_SYMLINKS`. Fails closed if `openat2` is unsupported. |
| T-02 | **Capability escalation** (`session.open` requesting `allowWrite: true` or widening limits) | Host capabilities are authoritative. `session.open` can only narrow `allow_write`, subpaths, and `HardLimits`. |
| T-03 | **Secret / metadata exfiltration** (reading `.git`, `state_dir`, `.env`, keys; leaking file content to `stderr`) | Host deny rules apply uniformly across `list`, `search`, `read`, and `patch`. `stderr` logs only sanitized operational diagnostics, never file contents. |
| T-04 | **Special files & hardlink side effects** (blocking on FIFO, corrupting `/dev/*`, mutating a hardlinked file outside workspace) | Reject non-regular files (FIFOs, sockets, devices, dirs) and reject `nlink > 1` on writes. |
| T-05 | **Stale / ambiguous edits** (short hash collision, line-shift race, partial multi-edit failure) | Require full 64-char hex BLAKE3 `expectedRevision`. Validate all `[startByte, endByte)` ranges against the original snapshot before writing; reject overlaps and stale anchors with `E_CONFLICT`. |
| T-06 | **Crash corruption / half-written files** | Write preimage + `PREPARED` journal record (`fsync`), write temp file in target directory (`fsync`), revalidate target `(dev, ino)` and revision, atomic `rename` + dir `fsync`, write `COMMITTED` (`fsync`). Startup recovery classifies `before` / `after` / `conflict`. |
| T-07 | **Duplicate mutation on reconnect** | Client-supplied `operationId` is stored with payload hash in the journal; retries return the cached result or `E_IDEMPOTENCY_CONFLICT` on mismatch. |
| T-08 | **Resource exhaustion / DoS** (huge frames, unbounded output, slow reader, `stdin` blocking) | 1 MiB max frame (closes connection), bounded `tokio` channels, output byte/record quotas (`limit_exceeded`), global queue+execution deadlines, concurrent `cancel`. |
| T-09 | **Arbitrary code execution** | Out of scope in K1/K2 (`allowExternalExec: false`); no shell-out in `list`, `search`, `read`, or `patch`. |

## 3. Residual Risks & Explicit Non-Goals (MVP)

- **Concurrent external writers**: Cooperative single-writer lock (`(dev, ino)` in `state_dir`) coordinates `ms` instances only. An external editor/process outside `ms` can modify a file between `ms`'s target revalidation and `rename` (small TOCTOU window). `ms` detects external changes prior to rename via full BLAKE3 digest, but does not provide OS-level mandatory locking against non-cooperative processes.
- **No OS sandbox for external processes yet**: Deferred to K4 (`bubblewrap` / cgroup v2 / network namespace).
