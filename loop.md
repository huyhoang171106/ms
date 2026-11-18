# Loop: make Axiom's Python REPL harness the strongest arm

You improve one harness: the single `python_repl` tool for Axiom (Unharnessed-style persistent cells plus Prime-Agent-style separation of model context from working state). Model is fixed at `anthropic/claude-haiku-5-5`. Each iteration changes exactly one harness thing, measures it, then keeps or reverts it. Ratchet: a kept change is never loosened later without new evidence.

## Files you own

- `integrations/axiom/python-repl.ts`: sandbox, kernel worker, preloaded helpers (`sh`, `patch`, `lint`, `Path`), tool description, 32 KiB output cap, `testShortcuts` option (env `MS_REPL_TEST_SHORTCUTS=0` disables).
- `benchmarks/run_abc5.sh`: A = ms JS, B = REPL batching, C = REPL batching + test-shortcut checks; 5 tasks x `TRIALS`, `TASKS_PARALLEL` tasks at once. Copy and edit its arm list for a new A/B.
- `benchmarks/ab_single_tool.ts`: arm prompts (`MS_REPL_BATCH_PROMPT=1` adds the batching workflow), environment block, oracle.
- `benchmarks/python_repl.check.ts`: deterministic self-check. Every new helper or limit gets one assertion here.
- `integrations/axiom/PYTHON_REPL.md`: keep in sync with behaviour.
- `benchmarks/tb/{runner.ts,harbor_agent.py,build.sh,run_ab.sh,summarize.py}`: Terminal-Bench arms, bundle and tables (iteration 7+).
- Axiom itself lives in `../nhom-30/axiom-cli` (team repo, other people's uncommitted work). The user asked (2026-11-19) to optimize Axiom's agent loop as well as the REPL: prefer the existing seams (`isComplete`, `completionReminder`, provider wrapper, event bus) from the runner; edit `src/core/agent-loop.ts` only when a seam cannot express the change, keep the diff minimal and record why (the file already has others' uncommitted edits).
- Read every dev trace before choosing a change; traces are the main source of hypotheses (user, 2026-11-19). Keep one small unread holdout only to check that a gain is not memorised.

## Evidence so far (do not re-derive)

| Finding | Source |
|---|---|
| 8 KiB output cap forced reads across extra turns; 32 KiB cut Chronos 309k to ~192k tokens | `benchmarks/artifacts/haiku-cap32-t3.*` |
| Missing CA bundle and overwritten `PYTHONPATH` wasted ~10 turns on Requests | fixed: `/etc/ssl/certs` mount, env note |
| Model-written `rep()` stops at first mismatch, one turn per bad string | fixed: `patch()` reports all mismatches, writes nothing |
| Only batching failure: import removed without re-import (`NameError`), hidden by noisy suite | fixed: `lint()` via `symtable`; Requests 2/3 149k to 3/3 87k (`haiku-repl-lint-t3.*`) |
| landmines-style test-shortcut checks in `lint()` (new sleep/retry/timeout/skip/constant assert, baseline-diffed) fired 0 times on 3 dev tasks; tokens moved within noise | `haiku-repl-honesty-t3.*`; A/B/C on 5 tasks in `abc5.*` |
| landmines/anti-slop oxlint rules on Axiom TS: 7,346 hits, >80% style; only the honesty subset (39 hits) is worth gating | measured 2026-11-18 |
| Remaining cost: exploration spread over 3 to 5 turns; every turn rereads all prior output from cache | open |
| Repo map (with `python3 -m pytest -q` hint) in system prompt: turns 6.3 to 5.7, 4/5 tasks −8% to −27% tokens, but Requests +27% (full-suite run, then chasing existing `httpbin` fixture errors); pooled +1.3%, reverted | `abc5.u3lZre`, code in `abc5.u3lZre/iter1-repoMap.ts.txt` |
| Repo map v2 (no test hint) in env block: pooled passed tokens 79,455 → 67,175 (−15.5%) on the old small-repo dev set. Kept in iteration 2, reverted to opt-in (`MS_REPL_REPO_MAP=1`) in iteration 6 after it measured negative on large repos | `abc5.ENmvYL` |
| Existing suite failures not caused by the agent (Requests `httpbin` fixture recursion) cost turns in both arms | `abc5.u3lZre` Requests traces |
| Eliding read outputs older than the latest edit cell (deterministic stub): pooled passed tokens +56%, turns 4.7 → 7.6, all 5 tasks worse; the model rereads or reconstructs stubbed files (Chronos: `git show`, `.pyc` disassembly). Do not drop source reads from context while the model is still editing. Baseline noise: Requests B-repl 122,521 (`abc5.ENmvYL`) vs 67,719 (`abc5.GzVGTP`) | `abc5.GzVGTP`, code in `iter3-elideReads.ts.txt` |
| `tests()` helper with a start-of-session pytest baseline (new vs pre-existing failures): pooled +30.5%, Requests +74%. The baseline run itself left files in the shared `/tmp`, creating a false "new failure" the model chased 4–6 turns. A retry must give every pytest run (baseline and later) its own fresh `TMPDIR` and still show pre-existing failures as such | `abc5.lLgLdX`, code in `iter4-tests-helper.diff.txt` |
| `tests()` v2 (fresh `TMPDIR` per pytest run): pooled +8.6%, Requests +31%; the model used it in only 7/15 runs and still ran its own `sh` pytest comparisons. Pre-existing-failure labelling is closed | `abc5.WjlT5t`, code in `iter5-tests-helper-v2.py.txt` |
| Baseline arm noise across runs exceeds the 5% keep bar: Requests B-repl 67,719 / 74,920 / 91,800 / 122,521, Chronos 143,461 to 187,978. Single-task deltas under ~25% are noise | `abc5.ENmvYL`, `GzVGTP`, `lLgLdX`, `WjlT5t` |
| Trial-0 runs can fail with 0 turns (`anthropic is not connected` / `login has expired`) when parallel runs refresh the OAuth token at once; count them as `infra-auth`, not arm failures | `abc5.lLgLdX` |
| Re-baseline on rotated sets: repo map is negative on large repos (dev −39% tokens without it, holdout −22%, 6/6 tasks), so it is opt-in again; final batching arm (no map) passes 9/9 dev and holdout with the lowest tokens of all arms (dev 26,209 vs A_eight 76,283; holdout 48,553 vs 126,495). Benchmark won; switch benchmark next | `abc5.eRXPvj` |
| Exercism (Aider polyglot Python) is saturated for Haiku: 45/45 pass across 3 arms at screening; B_repl already lowest tokens on 11/15. Its pack also leaked `.meta/example.py` (reference solution) into the workspace and did not guard the test file; both fixed | `abc5.KeNpvL` |
| Terminal-Bench 2.1 all-arm baseline (6 tasks x 3): pass A_eight 12/18, B_one 18/18, C_py 18/18, B_repl 18/18; norm(passed) A 148,105, B_one 121,429, C_py 85,162, B_repl 83,913. B_repl loses dev to B_one (26,119 vs 28,080) on multi-source-data-merger | `tb21-haiku-base7` |
| `host` kernel on the bundled interpreter cannot import container packages (pandas): 1–3 wasted turns per merger run. Kernel on the container's python3 (`hostPython()`): merger −32%, dev pooled −6.4%, holdout −27% (build-cython −32%), kept | `tb21-haiku-i7base`, `tb21-haiku-i7py`, `tb21-haiku-i7h*` |
| Same-arm Terminal-Bench baselines differ up to ~40% per task between runs (openssl B_repl 20,116 vs 14,466); judge per-task deltas under ~40% as noise | `tb21-haiku-base7`, `tb21-haiku-i7base` |
| All-arm `tb21-haiku-all8` (after `hostPython`): B_repl wins dev 20,212 vs B_one 23,320 / C_py 28,724; holdout C_py 133,199 vs B_repl 142,484 (all 9/9, equal turns) | `tb21-haiku-all8` |
| `lint()` false positives on real repos (`.pyx` parsed as Python, names already undefined at git HEAD) cost build-cython runs a verification turn; skipping non-`.py` and subtracting git-HEAD names: dev −31.5% (mostly build-cython, whose kept-state runs range 341k–502k), kept | `tb21-haiku-i9base`, `tb21-haiku-i9lint` |
| build-cython-ext B_repl is bimodal across runs (340,875 / 347,255 / 346,182 / 501,579 / 510,352): single A/Bs on it need the other dev tasks or a repeat to confirm | `tb21-haiku-*` |
| All-arm `tb21-haiku-all10`: dev B_repl 135,393 (best; C_py 164,148); holdout C_py 32,952 vs B_repl 36,956; all 18/18 | `tb21-haiku-all10` |
| Haiku completion on polyglot-c-py is mostly hidden reasoning (cells ≈ 6k chars/run vs 12–18k completion tokens); it swings run to run and the harness cannot shape it | `tb21-haiku-k10trace` |
| Environment note "no python3 on PATH, kernel is a private bundled interpreter": dev +52%, the model still hunts for python3 and spends turns on puzzle variants; reverted. Do not add environment notes for missing tools without a trace showing the note is read | `tb21-haiku-i10base`, `tb21-haiku-i10note` |
| Shell output, not file reads, is what grows B_repl context on Terminal-Bench: whole-file reads are 15–34% of B_repl output bytes (C_py 13–33%); screen10 B_repl printed 300 KB vs C_py 98 KB, ~77% of it command output (ps, apt/pip, build and test logs) | `tb21-haiku-all10`, `tb21-haiku-screen10`, `tb21-haiku-hold5` |
| `sh()` 8 KiB cap with spill file never fired on dev (0 spills; outputs < 8 KiB), reverted. Pass rate on git-multibranch/kv-store swings 0/3–2/3 between unchanged runs: use K=5 for pass-sensitive A/Bs | `tb21-haiku-i11base`, `tb21-haiku-i11sh` |
| Holdout v6 baseline: pass C_py 9/9, B_repl 8/9, B_one 8/9, A_eight 5/9; norm(passed) C_py 59,442, B_one 69,706, B_repl 85,911 (sanitize-git-repo 233,755 vs C_py 108,596) | `tb21-haiku-hold6` |
| Completion gate (Axiom `isComplete` seam, B_repl only): accept a stop right after a passing tool result; remind only after a failing one. Passes 10/15 → 13/15, tokens −4.9%, turns −1. `isComplete()` is also polled after every tool step, so the gate must check that the model just replied | `tb21-haiku-i12base`, `tb21-haiku-i12gate` |
| Holdout v4 all-arm baseline (all 9/9): norm(passed) C_py 29,483, B_one 33,663, B_repl 37,932, A_eight 43,199; B_repl completion is the highest (7,516 vs C_py 6,800) | `tb21-haiku-hold4` |
| Removing the batching workflow on Terminal-Bench: dev +7.6%, turns 5.11 → 5.78; the workflow earns its prompt cost, reverted | `tb21-haiku-i8base`, `tb21-haiku-i8nowf` |
| Flask and Tornado fail in every arm because the oracle matches literal import strings | excluded from tuning |
| ms JS beats batching by ~12% tokens on Chronos/Slug, fails Requests 0/3 on its test-guard | reference only |

## Task sets

Current benchmark (since iteration 7): Terminal-Bench 2.1 (`/tmp/tb/terminal-bench-2-1`), harbor in docker, arms `A_eight`, `B_one`, `C_py` (TB's plain CPython REPL) and `B_repl` (our `python_repl` in `host` mode + `PYTHON_REPL_WORKFLOW`).

- Dev (since iteration 11; tune on these): `git-multibranch`, `headless-terminal`, `kv-store-grpc` (holdout v5, promoted because its traces were read). Baseline `tb21-haiku-hold5`: pass B_one 8/9, B_repl 7/9, A_eight 4/9, C_py 2/9; norm(passed) B_repl 65,530, B_one 74,033.
- Holdout v6 (since iteration 11; never read their traces, only score): `nginx-request-logging`, `sanitize-git-repo`, `vulnerable-secret`. Baseline `tb21-haiku-hold6`. Reserved: `pypi-server`. `db-wal-recovery` excluded (trace seen by mistake).
- Retired in iteration 11: `fix-git`, `prove-plus-comm`, `polyglot-c-py` (dev gaps within noise; polyglot cost is hidden reasoning).
- Retired in iteration 10: `sqlite-db-truncate`, `build-cython-ext`, `fix-code-vulnerability` (B_repl wins them all; holdout flat).
- Terminal-Bench 2.1 won after iteration 12 (`tb21-haiku-all13`): B_repl dev 7/9 at 42,618 (A_eight 7/9 at 85,503), holdout 9/9 at 42,459 (C_py 9/9 at 81,731). Dev v3 and holdout v6 retired; next step is picking a new benchmark (see "Won: switch benchmark"). Kept-change counter 0/3.
- Retired in iteration 8: `multi-source-data-merger`, `openssl-selfsigned-cert`, `git-leak-recovery` (B_repl wins them all).
- Picked from a 14-task, 1-trial screen (`benchmarks/artifacts/tb21-haiku-screen7`): dev = tasks where B_repl had the highest or near-highest tokens; `extract-elf` excluded (0/4 arms).
- Retired (never tune on again): all RefactorBench tasks used so far (won), old local packs (saturated), Aider polyglot exercism (saturated at screening). See `LOOP_LOG.md`.

Commands:

```bash
PROVIDERS="openai-codex anthropic" benchmarks/tb/build.sh   # after every harness change; the anthropic access token must outlive the run by 3h
ARMS="B_repl" TASKS="git-multibranch headless-terminal kv-store-grpc" MODEL=anthropic/claude-haiku-5-5 K=3 N=3 \
  OUT=benchmarks/artifacts/tb21-haiku-<name> benchmarks/tb/run_ab.sh   # per-arm pooled line with cache read/write/prompt/completion
```

For a baseline-vs-change A/B, build the baseline bundle to `ABX_OUT=/tmp/abx-base` and the change to `/tmp/abx`, and run the two jobs with different `ABX_OUT`. `benchmarks/tb/summarize.py <dir>` prints per-trial, per task x arm and pooled tables; `norm` equals `normalizedTotalTokens`. The RefactorBench runner (`run_abc5.sh`) stays for regression checks only.

## Won: switch benchmark

The current benchmark is won when, in one all-arm run, batching has pass rate ≥ every other arm and the lowest mean tokens on passed runs, on both dev and holdout. A win does not end the loop. Instead:

1. Retire both dev and holdout (log under "Retired" in `LOOP_LOG.md` with reason `won` and the artifact).
2. Pick a new dev (3 tasks) and holdout (3 tasks) from a different benchmark than the won one: another pack (`exercism`, `refactorbench-js`, `benchmarks/tb`) or a harder task type (bug fix with failing tests, multi-file refactor, long-output triage). Prefer tasks where some arm failed or tokens are high, so the set separates arms. Check each oracle fails on the untouched repo and passes on a reference fix; skip oracles no arm can pass for reasons outside the code.
3. Re-baseline all arms (`A_eight`, `B_one`, `B_repl`) on the new dev and holdout, then re-check kept changes as in "Overfitting" steps 3–5.
4. Continue normal iterations on the new dev.

## Overfitting: rotate the benchmark

Check after every keep/revert decision. The dev set is overfit when any of these holds:

- Dev improves (≥5% tokens or more passes) but the latest holdout run is flat or worse on the same arms.
- A kept change helps only one dev task and is neutral or negative on the rest.
- Dev is saturated: batching passes 3/3 everywhere and the last 2 iterations moved tokens less than 5%, so the set no longer separates good changes from noise.
- Any prompt line, helper or default can only be explained by a specific dev task (its file names, layout, commands or failure text).

When overfit:

1. Retire the current dev tasks (list them under "Retired" in `LOOP_LOG.md` with the reason; never tune on them again).
2. Promote the holdout to dev. Pick a fresh holdout of 3 to 5 unused tasks: other RefactorBench repos, the `exercism` or `refactorbench-js` packs, or `benchmarks/tb`. Prefer task types not yet covered (bug fix with failing tests, multi-file refactor, long-output triage). Skip tasks whose oracle no arm can pass for reasons outside the code (e.g. literal-string oracles like Flask/Tornado).
3. Re-baseline every arm on the new dev and holdout with `run_abc5.sh` before the next change.
4. Re-check each kept change on the new dev; revert any that is now negative.
5. Update "Task sets" above and the `CASES` list in `run_abc5.sh`.

## Iteration

1. Read `benchmarks/artifacts/LOOP_LOG.md` (create it if missing) and run the overfitting check above before choosing work. Pick the highest-ranked open item from the backlog below, or a new failure class you found in the last traces. State one hypothesis and the metric it should move.
2. Implement the smallest change in the owning file. `REFACTORBENCH_DIR=/tmp/ms-refactorbench.aoI3Zf` (clean, at `210b2d15`). `run_abc5.sh` arms are listed in `task()`; `run` takes `pack case label arm batch shortcuts map` (map sets `MS_REPL_REPO_MAP`, default 1; the baseline `B-repl` arm includes the map, add the change as a second arm). Add or update one assertion in `python_repl.check.ts`. Run `bun benchmarks/python_repl.check.ts`; it must print OK.
3. Run baseline vs change on dev, 3 trials each, with `benchmarks/run_abc5.sh` (edit its arm list; `REFACTORBENCH_DIR` at commit `210b2d15`, `TASKS_PARALLEL=3`). It writes `summary.tsv` into a fresh `benchmarks/artifacts/abc5.*`.
4. Keep the change only if batching pass count does not drop and mean `normalizedTotalTokens` on passed runs drops ≥5% or pass count rises. Otherwise revert it and log why.
5. Every 3 kept changes, run dev and holdout with all four arms (`A_eight`, `B_one`, `B_repl` x2). If holdout pass rate drops, revert the last kept change.
6. Append one row to `LOOP_LOG.md`: iteration, hypothesis, change, files, per-task pass/turns/mean tokens, keep or revert, artifact path. For every failed run, write a failure reason code from the trace (e.g. `undefined-name`, `env-missing-dep`, `oracle-literal`, `gave-up`, `wrong-edit`), not just pass/fail.

## Backlog (ranked by measured cost)

1. ~~Environment probe v2~~ done in iteration 2 (kept, `abc5.ENmvYL`). Follow-up "label tests already failing at start" tried in iteration 4 as `tests()` and reverted (`abc5.lLgLdX`, +30.5%); retried in iteration 5 with a fresh `TMPDIR` and reverted again (`abc5.WjlT5t`, +8.6%). Closed.
2. ~~Completion gate v2~~ kept in iteration 12 (`tb21-haiku-i12gate`: passes 10/15 → 13/15, −4.9% tokens, reminders 15/15 → 2/15 runs). Was: every run pays ≥1 forced "You stopped" turn; B_repl resumed work after it in 1/18 runs (`tb21-haiku-all10`) and 3/9 (`tb21-haiku-hold5`), and the useful resumes followed a failing last output (`[exit 127]`). In `tb/runner.ts`, B_repl `isComplete` = last tool output has no non-zero `[exit N]`, `Error:` or `Traceback`.
2b. Completion gate: when the model answers without a tool call, the harness runs `lint()` on files changed since start (diff against the pristine copy) plus the fastest relevant test command; on failure, return the result as a tool message and continue, max 2 retries. Report UNVERIFIED if checks cannot run.
3. Output offload: cell output above 32 KiB goes to `/tmp/cell-<n>.txt`; the reply shows head, tail and the path.
4. ~~Deterministic context elision~~ reverted in iteration 3 (+56% tokens, `abc5.GzVGTP`). Any later variant must keep source reads until the task is finished (e.g. elide only outputs of test/command runs superseded by a later identical command).
5. Loop detection: the same failing check signature twice in a row triggers a one-line nudge to change approach.

## Rules

- Never edit oracles, hidden tests, or task text. Never add prompt text that names a benchmark file, symbol or expected import string.
- A rule enters the prompt only when it traces to a failure seen in a trace; cite the artifact path in the log row.
- Prefer code (helpers, gates, sandbox fixes) over prompt text. Keep the batching prompt under 12 lines.
- Single-run numbers are noise: decide only on 3-trial means.
- Report tokens with cache reads and writes separated; total tokens are not cost.
- A benchmark win switches benchmark (see "Won: switch benchmark"); it does not stop the loop. There is no iteration limit; the loop runs until a human writes `STOP` as the last line of `LOOP_LOG.md`. After each benchmark win, write that benchmark's table to `LOOP_LOG.md`.

## End of every iteration

1. Update this file: add the finding to "Evidence so far" with its artifact path, strike or re-rank the backlog item, and fix any command that changed. `loop.md` plus `LOOP_LOG.md` must be enough to resume with an empty context.
2. Run `bun benchmarks/python_repl.check.ts` once more and leave the tree in a state that passes it.
3. Stop and reply with a short report (also the text a `claude -p` run prints), in this order:
   - Header line: `Iteration N: KEPT|REVERTED, <artifact path>`.
   - Hypothesis and change: one sentence each, plus files touched.
   - Table per dev task: pass base → change, mean turns base → change, mean `normalizedTotalTokens` on passed runs base → change, delta %.
   - Pooled line: pass count, tokens base → change (delta %), turns base → change (delta %), cache read / cache write / uncached prompt / completion base → change.
   - Failures: each failed run with its reason code.
   - Overfit check: which rule (if any) fired; kept-change counter `k/3` until the next holdout run; holdout result if run this iteration.
   - Next: the backlog item the next iteration will take.
   Then compact: an agent cannot run `/compact` itself, so run each iteration in a fresh process (context starts empty, nothing to compact):

```bash
while true; do
  claude -p "$(cat loop.md)" --permission-mode acceptEdits --allowedTools Bash || break
  rg -q '^STOP' benchmarks/artifacts/LOOP_LOG.md && break
done
```

In an interactive session started with `/loop @loop.md lam di.`, the agent schedules the next iteration with `ScheduleWakeup` (the `claude` alias in `~/.bashrc` must list `ScheduleWakeup,CronCreate,CronList,CronDelete,Monitor,TaskList,TaskStop` in `--tools`). The human may type `/compact` between iterations; otherwise run the `claude -p` for-loop above. Never write `STOP` yourself; only a human does, to end the loop.
