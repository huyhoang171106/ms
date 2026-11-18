# Python REPL for Axiom

`python_repl` is the only model-facing tool in this mode. Axiom still owns the model loop; the tool owns one CPython process per session. The kernel preloads `Path`, `lint(*paths)` (stdlib `symtable` check for syntax errors and undefined module-level names, skipping files with star imports; in `test_*.py`/`*_test.py` it also reports sleeps, retry/flaky markers, raised timeouts, skips/xfails and constant asserts added since the kernel started, adapted from interfere-inc/landmines) and two more helpers: `sh(cmd)` returns `[exit N]` plus combined output, and `patch({path: [(old, new), ...]})` applies exact replacements across files only if every one matches (`(old, new, count)` for repeats), reporting all mismatches with the closest line. Use Python's standard library and local executables for everything else.

## Register it

Create a `ToolRegistry(['python_repl'])`, register `createPythonRepl(workspace, stateDir)`, and use `buildPythonReplPrompt(DEFAULT_SYSTEM_PROMPT)` in `AgentLoop`. Tell the model its workspace is `/workspace`. Append `repoMap(workspace)` to the environment block: text files with line counts per directory, Python directories first, at most 4 KB, plus the Python version and no test command (a full-suite hint sent the model chasing pre-existing failures). It is opt-in (`MS_REPL_REPO_MAP=1` in the A/B runner): it cut tokens 15% on small repos but cost +65% on large RefactorBench repos, where 4 KB covers a sliver of the tree and the ~2k-token map is re-read every turn. Keep the tool instance alive across turns and close it in `finally` when the session ends. The optional `stateDir/python` mount contains staged dependencies, not serialized kernel state.

```python
from pathlib import Path

def matching_files(needle):
    return [p for p in Path('.').rglob('*.py') if needle in p.read_text(errors='replace')]
```

In a later cell, `matches = matching_files('format_tags')` reuses the same function. Display only the needed result, e.g. `matches[:10]`. Use top-level `await` for async code; store tasks or subprocess results in variables to retrieve them in a later cell. Use `capture_output=True` for synchronous subprocess output or `asyncio.subprocess.PIPE` with `communicate()` for asynchronous output. Late output from an earlier cell does not leak into a later cell's reply.

## Limits

- Linux with Bubblewrap and user namespaces by default. The only unsandboxed mode is the explicit `host: { python }` option, for callers that already run inside a disposable container (Terminal-Bench `B_repl` in `benchmarks/tb/runner.ts`): the kernel then runs in the real workspace path with the container's network and environment, on `hostPython()` (the environment's python3 if ≥3.9, so packages installed there import in cells; else the bundled interpreter). The workspace is writable and no network is available. Use a disposable, secret-free worktree. The workspace mount is not a snapshot or rollback mechanism.
- Replies are capped at 32 KiB before JSON framing. Timeout stops the kernel without replaying the cell. The next call starts a fresh kernel and reports the state loss; file changes persist. Explicitly closing the tool prevents restarts. The launcher sets Linux `RLIMIT_NPROC` to 256 (per real UID, not a dedicated sandbox quota). The 512 MiB address-space limit applies per process, not to the whole sandbox.
- This borrows Unharnessed's persistent async cells and Prime Agent's separation of model context from working state, not automatic harness rewriting, untrusted checkpoint loading, or recursive agents.

Run the deterministic check with `bun benchmarks/python_repl.check.ts`. The A/B runner selects this mode with `--arms A_eight,B_repl --pack uc01 --lean`.
