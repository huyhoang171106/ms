# `ms` as Axiom's one tool

Axiom ships eight tools: `run_command`, `read_file`, `write_file`, `edit`, `apply_patch`, `list_dir`, `search_code`, `run_tests`. Every one is a round trip and a JSON schema, and every result pours into the context and stays there.

This package replaces all eight with one tool called `ms`. The model writes a JavaScript program whose only global is an async capability table; the program runs against the workspace on the `ms` runtime, and only the value it `return`s reaches the conversation.

| | Eight tools | **One `ms` tool** |
|---|---|---|
| Read + search + edit + verify | 4 calls, 4 results in context | **1 call, 1 result** |
| A 40k-line build log | 40k lines in context | **a variable; the 10 failing lines in the result** |
| A check across 200 files | 200 calls, 200 results | **1 loop, 1 result** |
| Tool definitions sent per request | 4,310 bytes | **2,213 bytes (−48.7%)** |

The reduction is measured, not asserted: `new ToolRegistry().getDefinitions()` against `createMsTool(...).toDefinition()`.

## What still holds

The guarantees the eight tools carried do not move to the model, they move into the runtime:

- **Root confinement** — `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)`; traversal, symlinks, FIFOs, hardlinks refused (see `docs/threat-model.md`).
- **Revision-checked edits** — every mutation carries a BLAKE3 `expectedRevision` or hashline tag; a stale or missing one returns `E_CONFLICT` with fresh context instead of guessing.
- **Atomicity** — preimage + `PREPARED` journal + temp file + `fsync` + atomic `rename`, and `ms.batch` rolls the whole batch back in reverse order on any failure.
- **Durable undo** — `ms.undo({transactionId})` restores the preimage from the journal, crash-recoverable.
- **Axiom's test-guard** — `ms.write` / `ms.edit` / `ms.rm` / `ms.mv` run through the adapter's guarded mutators, so weakening, skipping or deleting a test is refused before the journal. `ms.batch` refuses test paths outright for the same reason.
- **Distilled command output** — `ms.exec` returns a header, the failures and hashline snippets, plus a `logId` for the raw log.
- **Axiom's approval gate** — see below.

## Wiring it into Axiom

Build the binary once:

```bash
cd /path/to/ms && cargo build --release
```

Register the tool where the session registry is built (`src/core/execution-context.ts`):

```ts
import { buildMsSystemPrompt, createMsTool } from '/path/to/ms/integrations/axiom/ms-tool.js';
import type { BaseTool } from '../tools/base-tool.js';

const ms = createMsTool({
  msBin: process.env.AXIOM_MS_BIN ?? '/path/to/ms/target/release/ms',
  workspaceRoot,
  stateDir: path.join(os.homedir(), '.axiom', 'ms-state'),   // required once writes are enabled
  allowWrite: true,
  // Fail closed: no approver and no opt-out ⇒ every mutation is refused.
  approve: async (request) =>
    (await tools.approver?.({
      name: request.kind,
      args: { path: request.path, paths: request.paths, command: request.command },
      reason: request.reason,
      risk: 'medium',
    })) === 'approve'
      ? 'allow'
      : 'deny',
});

for (const replaced of ['run_command', 'read_file', 'write_file', 'edit', 'apply_patch', 'list_dir', 'search_code']) {
  tools.unregisterTool(replaced);
}
tools.registerTool(ms as unknown as BaseTool);
```

One more line so a read-only program is not prompted for the whole tool (mutations are still gated one by one inside it) — in `src/tools/permissions.ts`, `decide()`'s `known` array:

```ts
const known = ['ms', 'run_command', 'read_file', /* … */];
```

And wrap the session's system prompt with `buildMsSystemPrompt(systemPrompt)` so multi-tool references (`"edit"`, `"write_file"`, `read_file`) are rewritten to `ms` and the code-mode workflow guide is attached.

Role-scoped registries (`tools.scoped([...])`) and `READ_ONLY_TOOLS` are name-based: pass `ms` there, and construct the tool with `readOnly: true` for a reviewer role.

## The program surface

```js
const file = await ms.read('src/lib.rs');                    // {path, revision, totalLines, text}  (hashline by default)
const hits = await ms.search('pub fn', { maxMatches: 5 });    // {hits: [{path, line, text, tag}], truncated}
await ms.edit('src/lib.rs', { oldText, newText }, { expectedRevision: file.revision });
const run  = await ms.exec('cargo test --workspace');        // {exitCode, output, logId}
return { failing: run.exitCode !== 0 && run.output.split('\n').slice(0, 5) };
```

`ms.read` · `ms.list` · `ms.search` · `ms.outline` · `ms.context` · `ms.tx` are read-only.
`ms.write` · `ms.edit` · `ms.batch` · `ms.rm` · `ms.mv` · `ms.undo` and any non-inspection `ms.start`/`ms.exec`/`ms.kill` ask the approver once, when they run — not once for the whole program, so a program that starts by reading cannot quietly write.

## Shells are handles, not digests (learned from Unharnessed)

A distilled command output is still a guess about what the model needed. `ms.start` instead hands back a
live handle: the command runs outside the program, the log is on disk, and the model reads exactly the bytes
it asks for — including in a *later* turn.

```js
// three suites in parallel, inside one call
const jobs = await Promise.all(['unit', 'lint', 'build'].map((n) => ms.start(`npm run ${n}`)));
const done = await Promise.all(jobs.map((j) => ms.wait(j.id, { timeoutMs: 300_000 })));
const failing = await Promise.all(jobs.map((j) => ms.grep(j.id, 'FAIL|error', { context: 1, max: 20 })));
return { codes: done.map((j) => j.exitCode), failing };
```

```js
// a 20-minute job does not have to fit in one call
return { id: (await ms.start('cargo test --workspace', { timeoutMs: 0 })).id };   // turn ends here
// … next turn: ms.wait(id), ms.tail(id, 60), ms.grep(id, '^test .* FAILED'), ms.kill(id)
```

| | `ms.exec` (one shot) | `ms.start` (handle) |
|---|---|---|
| Blocks the program | yes | no |
| Parallel commands | one per call | up to 16 |
| Outlives the call | no | yes — the session owns it |
| What you read | distilled header + snippets | `tail`/`head`/`output`/`grep` on the real log |
| Long command | timeout risk | `timeoutMs: 0` lifts the 600s default |

`tail(n)` and `head(n)` come from bounded buffers (64 KiB head, 512 KiB tail); `grep` reads the full log from
disk, line-numbered, with up to 5 context lines. `kill` signals the whole process group (`SIGTERM`, then
`SIGKILL` after 500 ms), and `close()` kills anything still live so a session cannot leak process groups.

## Budgets

| Knob | Default | Effect |
|---|---|---|
| `limits.maxCalls` | 256 | host calls per program; the 257th throws inside the program |
| `limits.timeoutMs` | 180000 | wall clock; in-flight `ms` calls are cancelled (`AbortSignal` → protocol `cancel`) |
| `limits.maxResultBytes` | 65536 | the rendered result is truncated with a byte count, never silently |

A program that returns nothing renders as `ok (no value returned)`; `console.log` output is collected and appended after the result, never interleaved.

## Ceiling

- `node:vm` is a **correctness** boundary, not a security one. A program cannot `require`, use `process`, or reach the filesystem except through the `ms` table, but a determined adversarial program is not the threat model here: the model is. Run untrusted code in a container.
- The tool replaces file and shell *capability*, not Axiom's shell policy: `ms.exec` gates on `isReadOnlyInspectionCommand`, which is a coarser rule than `decide('run_command', …)`. If you need Axiom's per-argv allowlist, keep `run_command` and hand the model both tools.
- Approvals are coarse by design: one prompt per mutating call, no argument editing. `editedArgs` is not supported; refuse and re-ask instead.

## Check

```bash
bun integrations/axiom/selftest.ts
```

Eight properties, on a throwaway copy of `tests/fixtures/small-repo`: one call does read+search+list+shell; an approved edit is journaled and undone; a stale revision is refused; the test-guard blocks a weakened test; a denied command never runs; a runaway program is stopped; the call budget holds; a missing approver refuses writes.
