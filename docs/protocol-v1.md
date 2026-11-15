# Protocol v1 Specification (`ms`)

**Status:** Active (v1.0)  
**Wire Format:** Newline-Delimited JSON (NDJSON) over `stdin` / `stdout` (plus MCP JSON-RPC 2.0 over stdio via `ms mcp`)  
**Protocol Version:** `"1.0"`

> Note: Protocol v1 is an explicit, versioned NDJSON protocol. For MCP clients (Claude Code, Pi, Cursor, Antigravity), use `ms mcp` which translates MCP JSON-RPC 2.0 tool calls onto the same `Runtime` and security/journal guarantees.

## 1. Transport & Framing

- **Encoding:** UTF-8 JSON objects separated by `\n` (one JSON object per line on `stdin` and `stdout`).
- **Frame limit:** Default `1 MiB` (`1,048,576` bytes) per line. Oversized frames emit a fatal `protocol_error` (`E_PROTOCOL`) and close the connection.
- **Channel separation:**
  - `stdout`: **NDJSON events only**.
  - `stderr`: Sanitized operational diagnostics only. File contents, secrets, and raw user payloads must never be written to `stderr`.
- **Non-blocking `cancel`:** The server's `stdin` reader must never block waiting for an in-flight operation to finish; `cancel` requests are processed concurrently.

## 2. Request Envelope (Client → Server)

Every request is a JSON object with:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | Connection-unique non-empty request ID. Duplicate IDs are rejected with `E_DUPLICATE_REQUEST_ID` without re-executing. |
| `method` | `string` | Yes | One of `initialize`, `session.open`, `session.close`, `call`, `cancel`. |
| `params` | `object` | Optional | Method-specific parameters (defaults to `{}` for `initialize` and `session.open`). |

### 2.1. `initialize`

```json
{"id":"r1","method":"initialize","params":{"clientName":"axiom","clientVersion":"0.1.0"}}
```

Returns `completed.result`:

```json
{
  "protocolVersion": "1.0",
  "serverName": "ms",
  "serverVersion": "0.1.0",
  "capabilities": {
    "operations": [
      "list", "search", "read", "outline", "context_bundle", "tx.list", "schema",
      "patch", "patch.batch", "edit", "write_file", "delete_file", "rename_file", "tx.undo"
    ],
    "allowWrite": true,
    "allowExternalExec": false,
    "supportsCancellation": true,
    "supportsIdempotency": true,
    "maxLimits": {
      "maxFrameBytes": 1048576,
      "maxEditFileBytes": 8388608,
      "maxBatchRecords": 256,
      "maxOutputBytesPerRequest": 1048576,
      "defaultDeadlineMs": 30000,
      "maxDeadlineMs": 300000,
      "maxConcurrentReadsPerConnection": 4,
      "maxConcurrentMutationsPerWorkspace": 1
    }
  }
}
```

Clients must inspect `capabilities` and must not infer capabilities from `serverVersion`.

### 2.2. `session.open` / `session.close`

```json
{"id":"r2","method":"session.open","params":{"capabilities":{"allowWrite":false,"readSubpaths":["src"]}}}
{"id":"r3","method":"session.close","params":{"sessionId":"s1"}}
```

- Session capabilities can only **narrow** host capabilities, never widen them.
- Closing a session (or closing `stdin` EOF) cancels in-flight read operations for that session; mutations past the commit boundary finish or recover cleanly via the durable journal.

### 2.3. `call`

```json
{
  "id": "r4",
  "method": "call",
  "params": {
    "sessionId": "s1",
    "operationId": "op-uuid-123",
    "deadlineMs": 10000,
    "operation": {
      "kind": "read",
      "path": "src/main.rs",
      "startLine": 1,
      "lineCount": 40,
      "format": "hashline"
    }
  }
}
```

- `operationId`: Optional (recommended for all mutations). Stable across reconnects/restarts.
  - Same `operationId` + same payload hash → returns stored outcome without re-applying (supported for single-file mutations and `patch.batch`).
  - Same `operationId` + different payload hash → `E_IDEMPOTENCY_CONFLICT`.
  - Expired epoch → `E_IDEMPOTENCY_EXPIRED`.
- `deadlineMs`: Applies to both queue wait time and execution time, clamped to `maxLimits.maxDeadlineMs`.

### 2.4. `cancel`

```json
{"id":"r5","method":"cancel","params":{"requestId":"r4"}}
```

## 3. Operations (`Operation`)

| `kind` | Mutates | Key Parameters |
|---|---|---|
| `list` | No | `path?`, `recursive?`, `maxEntries?`, `includeHidden?`, `respectIgnore?` |
| `search` | No | `query`, `path?`, `regex?`, `caseSensitive?`, `maxMatches?`, `contextLines?` |
| `read` | No | `path`, `startLine?` (1-based), `lineCount?`, `format?` (`"json"` \| `"hashline"`) |
| `outline` | No | `path`, `maxSymbols?` |
| `context_bundle` | No | `query`, `path?`, `maxFiles?`, `maxLinesPerFile?`, `includeTests?` |
| `patch` | Yes | `path`, `expectedRevision` (64-hex BLAKE3), `edits[]` (`startByte`, `endByte`, `expectedText?`, `expectedTag?`, `replacement`), `dryRun?` |
| `edit` | Yes | `path`, `expectedRevision?`, `edits[]` (line-range `startLine`/`endLine` + optional `startTag`/`endTag`, `oldText`, or byte-range), `dryRun?` |
| `write_file` | Yes | `path`, `content`, `createIfMissing?`, `overwrite?`, `expectedRevision?`, `dryRun?` |
| `delete_file` | Yes | `path`, `expectedRevision?`, `dryRun?` |
| `rename_file` | Yes | `from`, `to`, `overwrite?`, `expectedRevision?`, `dryRun?` |
| `patch.batch` | Yes | `operations[]` (`patch` \| `write_file` \| `delete_file`), `dryRun?` |
| `tx.list` | No | `operationId?`, `limit?`, `includeUndone?` |
| `tx.undo` | Yes | `transactionId?` (must be latest un-undone tx if provided) |
| `schema` | No | `operation?` |

### `patch`, `edit`, and `patch.batch` Semantics

- Target regular UTF-8 files only (no symlinks, FIFOs, or multi-link hardlinks).
- `patch` uses byte offsets `[startByte, endByte)` against `expectedRevision`.
- `edit` supports 1-based line ranges (`startLine`/`endLine` with optional hashline tags `startTag`/`endTag`), exact `oldText` matching, or byte ranges. On stale revision or tag mismatch, `E_CONFLICT` includes self-healing `currentRevision` and fresh `hashline` context around the target lines.
- `patch.batch` validates all items up-front via dry-run, executes sequentially with per-item journaled transactions, rolls back earlier items in reverse order on any mid-batch failure, and records a `BatchCommitted` journal entry for batch-level `operationId` idempotency.
- Preserves uniform `LF` or `CRLF`, UTF-8 BOM, and absence/presence of trailing newline; mixed EOL or invalid UTF-8 is rejected.

## 4. Event Envelope (Server → Client)

Every accepted request with a valid `id` receives zero or more `records` / `bytes` / `diagnostic` events followed by **exactly one** terminal `completed` event.

```json
{"requestId":"r4","seq":1,"type":"records","records":[...],"schemaVersion":"1.0"}
{"requestId":"r4","seq":2,"type":"completed","status":"ok","truncated":false,"counters":{"recordsEmitted":10,"bytesEmitted":512,"durationMs":4},"result":{...}}
```

- `completed.status`: `"ok" | "error" | "cancelled" | "timeout" | "limit_exceeded"`.
- Invalid JSON without a valid `id` emits `{"seq":0,"type":"protocol_error","code":"E_PROTOCOL","message":"...","fatal":false}`.

## 5. CLI Modes (`ms mcp`, `ms exec`, `ms log`)

- `ms mcp [OPTIONS]`: Runs an MCP JSON-RPC 2.0 server over stdio exposing `ms_list`, `ms_search`, `ms_read`, `ms_outline`, `ms_context_bundle`, `ms_edit`, `ms_write_file`, `ms_delete_file`, `ms_rename_file`, `ms_patch_batch`, `ms_tx_list`, `ms_tx_undo`, and (when `--allow-write` or enabled) `ms_exec` / `ms_log`.
- `ms exec [--root <DIR>] [--timeout <MS>] [--] <CMD...>`: Executes a command, distills noisy output (pytest, jest/vitest, tsc, eslint, git diff/status), attaches `hashline` failure snippets, and saves raw logs under `/tmp/ms-logs` (with automatic TTL/count GC).
- `ms log --id <ID> [--tail <N>] [--grep <PATTERN>]`: Reads/filters saved raw logs from `/tmp/ms-logs`.
