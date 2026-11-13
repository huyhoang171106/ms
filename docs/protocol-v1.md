# Protocol v1 Specification (`ms`)

**Status:** Active (MVP K1/K2)  
**Wire Format:** Newline-Delimited JSON (NDJSON) over `stdin` / `stdout`  
**Protocol Version:** `"1.0"`

> Note: Protocol v1 is an explicit, versioned NDJSON protocol. It is not JSON-RPC 2.0.

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
    "operations": ["list", "search", "read", "patch", "tx.list", "tx.undo", "schema"],
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
      "lineCount": 40
    }
  }
}
```

- `operationId`: Optional (recommended for all mutations). Stable across reconnects/restarts.
  - Same `operationId` + same payload hash → returns stored outcome without re-applying.
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
| `read` | No | `path`, `startLine?` (1-based), `lineCount?` |
| `patch` | Yes | `path`, `expectedRevision` (64-hex BLAKE3), `edits[]` (`startByte`, `endByte`, `expectedText?`, `expectedTag?`, `replacement`), `dryRun?` |
| `tx.list` | No | `operationId?`, `limit?`, `includeUndone?` |
| `tx.undo` | Yes | `transactionId?` (must be latest un-undone tx if provided) |
| `schema` | No | `operation?` |

### `patch` Semantics

- Targets a single existing regular UTF-8 file (no symlinks, FIFOs, or multi-link hardlinks).
- `edits` are byte offsets `[startByte, endByte)` against the **original snapshot** (`expectedRevision`).
- Overlapping ranges and duplicate point inserts are rejected before any write.
- Edits are applied in descending offset order.
- Preserves uniform `LF` or `CRLF`, UTF-8 BOM, and absence/presence of trailing newline; mixed EOL or invalid UTF-8 is rejected.
- `expectedText` and `replacement` use `LF` on the wire; the runtime converts `replacement` to the file's EOL.

## 4. Event Envelope (Server → Client)

Every accepted request with a valid `id` receives zero or more `records` / `bytes` / `diagnostic` events followed by **exactly one** terminal `completed` event.

```json
{"requestId":"r4","seq":1,"type":"records","records":[...],"schemaVersion":"1.0"}
{"requestId":"r4","seq":2,"type":"completed","status":"ok","truncated":false,"counters":{"recordsEmitted":10,"bytesEmitted":512,"durationMs":4},"result":{...}}
```

- `completed.status`: `"ok" | "error" | "cancelled" | "timeout" | "limit_exceeded"`.
- Invalid JSON without a valid `id` emits `{"seq":0,"type":"protocol_error","code":"E_PROTOCOL","message":"...","fatal":false}`.
