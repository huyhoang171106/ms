# `ms` as Axiom's one tool

Axiom ships eight tools: `run_command`, `read_file`, `write_file`, `edit`, `apply_patch`, `list_dir`, `search_code`, `run_tests`. Every one is a round trip and a JSON schema, and every result pours into the context and stays there.

This package replaces all eight with one tool called `ms`. The model writes a JavaScript program in a separate sandboxed Node process. Workspace access goes through the `ms` capability table, and only the returned value and collected logs reach the conversation.

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
- **Revision-checked changes** — edits, overwrites, deletes and renames require the BLAKE3 revision returned by `ms.read`. New files use create-only writes. Rename cannot overwrite an existing destination.
- **Atomicity** — preimage + `PREPARED` journal + temp file + `fsync` + atomic `rename`, and `ms.batch` rolls the whole batch back in reverse order on any failure.
- **Durable undo** — `ms.undo({transactionId})` restores the preimage from the journal, crash-recoverable.
- **Test protection** — existing test files and test configuration cannot be edited, deleted, renamed or overwritten. New test files use create-only writes and still pass the adapter guard.
- **Bounded command output** — `ms.exec` returns an exit code, bounded output and a session-scoped job log ID.
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
const file = await ms.read('src/lib.rs');                    // {path, revision, totalLines, text}  exact text; format:'hashline' for tagged lines
const tree = await ms.list('src', { recursive: true });       // ['src/lib.rs', 'src/bin/', ...]  dirs end in '/'
const hits = await ms.search('pub fn', { maxMatches: 5 });    // {hits: [{path, line, text}]}  truncated only when true
await ms.edit('src/lib.rs', { oldText, newText }, { expectedRevision: file.revision }); // {path, revision, transactionId, editsApplied}
const run  = await ms.exec('cargo test --workspace');        // {exitCode, output, logId}  output capped at 4 KB head+tail (maxBytes)
return { failing: run.exitCode !== 0 && run.output.split('\n').slice(0, 5) };
```

Results come back as compact JSON. `ms.read` metadata (`truncated`, `startLine`, `endLine`, `nextStartLine`) appears only when the window is cut, `hasBom` only when true.

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
| What you read | bounded output | `tail`/`head`/`output`/`grep` on the real log |
| Long command | timeout risk | `timeoutMs: 0` lifts the 600s default |

`tail(n)` and `head(n)` come from bounded buffers (64 KiB head, 512 KiB tail); `grep` reads the retained first and last 512 KiB of a finished log from
disk, line-numbered, with up to 5 context lines. While a job is running, its disk log contains the retained beginning. `kill` signals the whole process group (`SIGTERM`, then
`SIGKILL` after 500 ms), and `close()` kills anything still live so a session cannot leak process groups.

## Budgets

| Knob | Default | Effect |
|---|---|---|
| `limits.maxCalls` | 256 | host calls per program; the 257th throws inside the program |
| `limits.timeoutMs` | 180000 | wall clock; in-flight `ms` calls are cancelled (`AbortSignal` → protocol `cancel`) |
| `limits.maxResultBytes` | 24576 | total UTF-8 response budget, including result, logs, errors and header |

A program that returns nothing renders as `ok (no value returned)`; `console.log` output is collected and appended after the result, never interleaved.

## Isolation and limits

- Linux, `bwrap`, working user/PID/network namespaces, and Node.js are required. If sandbox startup fails, no guest code runs.
- Each program runs in a fresh sandbox without the workspace, state directory, home, inherited environment or network. Host calls use a bounded JSON channel. The guest can use its own Node runtime, so the OS sandbox is the security boundary.
- Each `ms.exec` or `ms.start` runs in a separate writable snapshot of policy-readable, non-ignored files. The snapshot excludes `.git`, secrets, symlinks and hardlinks. Shell writes disappear when the job finishes. Use the file API to persist changes.
- Snapshots are limited to 8 MiB per file and 64 MiB total. The writable workspace and temporary directory are capped at 128 MiB and 64 MiB. A truncated listing or an oversized snapshot fails closed. System tools under `/usr` and `/bin` are mounted, as are the `node` and `bun` executables found on PATH. Their home directories and project dependencies ignored by Git are not mounted.
- For commands containing `pytest`, copies of the installed pytest modules and their basic dependencies are staged separately without mounting home. Other user-installed Python modules and plugins are not mirrored, so tests depending on them can fail inside the sandbox even if they pass on the host.
- `bwrap` isolates the filesystem and network but this integration does not impose cgroup CPU, memory or process-count limits. Do not treat it as a complete multi-tenant resource boundary.
- Reviewer sessions do not expose shell or mutation functions. Undo of a rename is unavailable because the transaction listing does not expose its destination. Approvals are per mutation; argument editing is not supported.

## Check

```bash
bun integrations/axiom/selftest.ts
```

The self-test uses a throwaway workspace and checks isolation, test protection, bounded output, approvals, journal operations and job control.

## C_py: Python REPL as the only tool (EXPERIMENTAL)

> **Experimental.** The interface, prompt and defaults may change without notice. Model-written Python and shell run **unsandboxed, as you**, in `--cwd`. Use it only in a directory you can afford to lose, or in a container.

`cpy.ts` is the Terminal-Bench C_py arm: one `python` tool over a persistent CPython process (`cpy_kernel.py`, with `bash(cmd)` that returns `[exit N]\n<output>`), the terse spec `PYTHON_SYSTEM`, and `createCpyGate`, the chat gate the arm runs with (old-output trimming, one completion reminder, one nudge for a stop that admits a gap, text-as-call recovery, retry on spurious "flagged" errors). `benchmarks/tb/runner.ts` and the command below share it.

```bash
bun integrations/axiom/cpy-cli.ts --cwd ./scratch "Fix the bug in calc.py so the tests pass."
echo "task" | bun integrations/axiom/cpy-cli.ts --model openai-codex/gpt-6-luna --effort medium --max-steps 150
```

`--replay` (Responses routes only) replays the model's encrypted reasoning across turns and sends one `prompt_cache_key` per run with `text.verbosity: low`, as pi and codex do (`responses-replay.ts`). It is off by default: a concurrent Terminal-Bench A/B showed no measurable gain. A stream that sends nothing for 120s is failed so Axiom retries it.

Axiom is loaded from `AXIOM_CLI_DIR` (default `../nhom-30/axiom-cli` next to this repo) and uses its logins. Progress goes to stderr and the final reply to stdout. The exit code is 0 when the run completed, 1 when it failed, and 2 for bad arguments. On the host the spec says the agent is the user (no sudo, no system-wide installs) instead of root in a container.

Check: `bun test integrations/axiom/cpy.test.ts` and `python3 integrations/axiom/cpy_kernel.py --selftest`.
