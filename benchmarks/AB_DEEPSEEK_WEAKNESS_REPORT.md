# Controlled A/B Diagnosis: `trollllm/deepseek-v4-1-flash` on Axiom UC01

- **Experiment ID**: `uc01-controlled-seed42-2026-11-14T14-48-13-211Z`
- **Artifacts**: [`benchmarks/artifacts/deepseek-v4-1-flash-t3-seed42/`](./artifacts/deepseek-v4-1-flash-t3-seed42/)
- **Model**: `trollllm/deepseek-v4-1-flash` (`api: openai-completions`, `pricingStatus: unpriced`)
- **Design**: 3 paired trials × 3 UC01 bug cases × 2 arms (`A_baseline` vs `B_ms`) = **18 runs** (`--mode controlled --seed 42 --max-steps 20`)

---

## 1. Executive Summary

`B_ms` **lost badly** to `A_baseline` on `trollllm/deepseek-v4-1-flash`:
- **Verified Pass Rate (`overallPassed`)**: **`3/9` (33.3%)** for `B_ms` vs **`9/9` (100.0%)** for `A_baseline` (**-66.7 pp**).
- **Target Fixed (`targetFixed`) & No Regressions (`noRegressions`)**: `B_ms` achieved **`8/9` (88.9%)** on both, vs **`9/9` (100.0%)** for `A_baseline`.
- **Why `B_ms` failed**: **6 of 9 `B_ms` runs hit `Exceeded maximum steps (20)`** (`agentStatus = "error"`), compared to **0/9** in `A_baseline`. Even on the 3 runs where `B_ms` passed (`uc01-02-bug-test-fail`), it required **16–18 LLM turns** (median 18) vs `A_baseline`'s **8–9 turns** (median 9).

**Primary Root Cause**: `ms exec` (backing `run_command` and `run_tests` in `B_ms`) strips stdout/stderr into a ~80–130-byte summary header + `.ms/logs/...` path, forcing DeepSeek V4.1 Flash to spend an extra `read_file` turn after nearly every command/test run (**43.0% of all `B_ms` `read_file` calls immediately followed `run_command`/`run_tests`**). Although `B_ms` reduced raw tool output bytes by **45.1%** (`64,186 B` vs `116,878 B`), the extra round-trips increased LLM turns by **+37.6%** (`172` vs `125`), total tokens by **+22.6%** (`855,732` vs `697,880`), and wall-clock time by **+15.7%** (`359.6s` vs `310.9s`), exhausting the 20-step budget before the agent could finish.

---

## 2. Aggregate Arm Comparison (`A_baseline` vs `B_ms`)

| Metric | `A_baseline` (9 runs) | `B_ms` (9 runs) | Delta (`B - A`) |
|---|---:|---:|---:|
| Verified Success (`overallPassed`) | **9 / 9 (100%)** | **3 / 9 (33.3%)** | **-6 (-66.7 pp)** |
| Target Fixed (`targetFixed`) | 9 / 9 (100%) | 8 / 9 (88.9%) | -1 (-11.1 pp) |
| No Regressions (`noRegressions`) | 9 / 9 (100%) | 8 / 9 (88.9%) | -1 (-11.1 pp) |
| Infra / Step-Limit Errors | 0 | 6 (`Exceeded maximum steps (20)`) | +6 |
| Total Wall-Clock Time | 310,906.41 ms | 359,579.87 ms | +48,673.46 ms (+15.7%) |
| Total LLM Turns | 125 | 172 | +47 (+37.6%) |
| Total Tool Calls | 174 | 230 | +56 (+32.2%) |
| Tool Registry Failures (`isError`) | 16 (9.2%) | 18 (7.8%) | +2 |
| Command Non-Zero Exits | 32 | 28 | -4 |
| Total Tool Output Bytes | 116,878 B | 64,186 B | -52,692 B (-45.1%) |
| `uncachedInput` Tokens | 39,134 | 46,420 | +7,286 (+18.6%) |
| `cacheRead` Tokens | 637,056 | 783,744 | +146,688 (+23.0%) |
| `cacheWrite` Tokens | 0 | 0 | 0 |
| `output` Tokens | 21,690 | 25,568 | +3,878 (+17.9%) |
| **Total Tokens** | **697,880** | **855,732** | **+157,852 (+22.6%)** |
| Cost (USD) | `unpriced` (`null`) | `unpriced` (`null`) | `null` |

---

## 3. Paired Deltas by Case (`B_ms - A_baseline`)

| Case ID | Pairs | `passDelta (B - A)` | Median Wall-Clock Delta | Median Turns Delta |
|---|---:|---:|---:|---:|
| `uc01-01-bug-crash-null` | 3 | **-3** (0/3 vs 3/3) | +5,097.91 ms | +2 turns |
| `uc01-02-bug-test-fail` | 3 | **0** (3/3 vs 3/3) | +20,542.32 ms | +9 turns |
| `uc01-03-bug-reproducible` | 3 | **-3** (0/3 vs 3/3) | -3,046.46 ms | +5 turns |

Per-trial breakdown:
- `uc01-01-bug-crash-null`:
  - T1 (`BA`): `A` pass (14 turns, 23 tools, 29.0s) vs `B` fail-max-steps (20 turns, 25 tools, 42.4s, `targetFixed=true`)
  - T2 (`BA`): `A` pass (18 turns, 24 tools, 36.5s) vs `B` fail-max-steps (20 turns, 29 tools, 41.6s, `targetFixed=true`)
  - T3 (`AB`): `A` pass (20 turns, 31 tools, 49.2s) vs `B` fail-max-steps (20 turns, 29 tools, 45.8s, `targetFixed=true`)
- `uc01-02-bug-test-fail`:
  - T1 (`AB`): `A` pass (8 turns, 12 tools, 16.4s) vs `B` pass (18 turns, 22 tools, 36.9s)
  - T2 (`AB`): `A` pass (9 turns, 11 tools, 18.9s) vs `B` pass (18 turns, 25 tools, 39.6s)
  - T3 (`BA`): `A` pass (9 turns, 12 tools, 18.3s) vs `B` pass (16 turns, 20 tools, 32.6s)
- `uc01-03-bug-reproducible`:
  - T1 (`AB`): `A` pass (13 turns, 18 tools, 41.2s) vs `B` fail-max-steps (20 turns, 25 tools, 40.7s, `targetFixed=false`, `noRegressions=false`)
  - T2 (`BA`): `A` pass (19 turns, 24 tools, 58.3s) vs `B` fail-max-steps (20 turns, 26 tools, 39.9s, `targetFixed=true`)
  - T3 (`AB`): `A` pass (15 turns, 19 tools, 43.0s) vs `B` fail-max-steps (20 turns, 29 tools, 40.0s, `targetFixed=true`)

---

## 4. Tool-Level Breakdown & Exact Errors

### 4.1 Per-Tool Call Volume, Failures, Output Bytes, and Latency

| Tool | `A_baseline` Calls (Err / NZ) | `A_baseline` Avg Bytes / Avg Dur | `B_ms` Calls (Err / NZ) | `B_ms` Avg Bytes / Avg Dur |
|---|---:|---:|---:|---:|
| `list_dir` | 10 (1 / 0) | 191.1 B / 1.5 ms | 9 (0 / 0) | 380.0 B / 2.2 ms |
| `read_file` | 58 (2 / 0) | 1152.1 B / 1.2 ms | **86** (**10** / 0) | 510.7 B / 1.2 ms |
| `search_code` | 4 (0 / 0) | 215.0 B / 6.0 ms | 3 (0 / 0) | 418.0 B / 1.7 ms |
| `apply_patch` | 20 (**7** / 0) | 106.0 B / 1.6 ms | *not registered* | — |
| `edit` | 2 (0 / 0) | 159.0 B / 2.0 ms | 8 (**0** / 0) | 64.6 B / 1.5 ms |
| `write_file` | 1 (0 / 0) | 129.0 B / 2.0 ms | 7 (**0** / 0) | 63.1 B / 2.0 ms |
| `run_command` | 50 (6 / 11) | 283.8 B / 37.5 ms | **108** (8 / 19) | **124.7 B** / **143.4 ms** |
| `run_tests` | 29 (0 / 21) | **1052.8 B** / 192.0 ms | **9** (0 / 9) | **130.0 B** / 26.2 ms |
| `ms_outline` | *n/a* | — | **0** | — |
| `ms_context` | *n/a* | — | **0** | — |
| `ms_undo` | *n/a* | — | **0** | — |

### 4.2 Exact Registry-Level Error Messages

**`B_ms` (18 errors total):**
1. **`read_file` (6×)**: `Error: E_POLICY_DENIED: invalid path: parent directory traversal ('..') is not allowed (Use a relative UTF-8 path inside the workspace root without '..' or symlinks.)`
2. **`read_file` (3×)**: `Error: E_NOT_FOUND: not found: path not found: 'skills/bug-fix/SKILL.md'`
3. **`read_file` (1×)**: `Error: E_NOT_FOUND: not found: path not found: 'workspace_probe.txt'`
4. **`run_command` (8×)**: `Blocked by policy (shell references a path outside the workspace). This action is never allowed; do not retry it in another form.`

**`A_baseline` (16 errors total):**
1. **`apply_patch` (7×)**: malformed unified diff (`invalid diff at line 3: hunk ends early...` ×4, `hunk has more lines than its header` ×1, `hunk before a ---/+++ file header` ×1, `unexpected line in hunk` ×1)
2. **`run_command` (6×)**: `Blocked by policy (shell references a path outside the workspace). This action is never allowed; do not retry it in another form.`
3. **`read_file` (2×)**: `File or directory not found: AGENTS.md` (1×), `File or directory not found: skills/bug-fix/SKILL.md` (1×)
4. **`list_dir` (1×)**: `Directory not found: evals/fixtures/uc01`

---

## 5. Concrete `ms` Weaknesses Observed in Traces

1. **`ms exec` (`run_command` / `run_tests`) over-distills small outputs and forces a 2-step `exec -> read_file(log)` loop (Critical)**:
   - `run_tests` in `B_ms` returned **130.0 B** on average (vs **1,052.8 B** in `A_baseline`), hiding the actual pytest assertion/traceback behind a `.ms/logs/...` path.
   - `run_command` in `B_ms` returned **124.7 B** on average (vs **283.8 B** in `A_baseline`), hiding even 1-line `python -c` outputs behind `.ms/logs/...`.
   - Consequently, **37 of 86 `read_file` calls in `B_ms` (43.0%)** occurred *immediately* after `run_command` or `run_tests` solely to inspect `.ms/logs/...`.
   - Because `run_tests` gave no inline failure details, the model abandoned `run_tests` (`9` calls in `B_ms` vs `29` in `A_baseline`) and spammed `run_command` (`108` calls in `B_ms` vs `50` in `A_baseline`), triggering `read_file(log)` after each one and exhausting the 20-step limit in **6/9 runs**.

2. **Zero adoption of `ms_outline`, `ms_context`, and `ms_undo` (0 calls across all 9 `B_ms` runs)**:
   - DeepSeek V4.1 Flash completely ignored `ms_outline`, `ms_context`, and `ms_undo`, falling back to `list_dir` + `read_file` + `run_command` for everything. Without stronger tool-selection cues or consolidating `ms_context`/`ms_outline` into the primary read/search workflow, registering extra `ms_*` tools adds schema tokens without saving turns.

3. **`ms` `read_file` `E_POLICY_DENIED` on `..` paths (6/86 calls = 7.0%)**:
   - `B_ms` had 5× more `read_file` failures than `A_baseline` (10 vs 2), 6 of which were `E_POLICY_DENIED: invalid path: parent directory traversal ('..') is not allowed`.

4. **`ms exec` adds ~106 ms overhead per `run_command` call**:
   - `B_ms` `run_command` averaged **143.4 ms** vs **37.5 ms** in `A_baseline` (+105.9 ms per call, ~11.4 s wasted across 108 calls).

5. **Where `ms` actually outperformed `A_baseline` (`edit` + `write_file` vs `apply_patch`)**:
   - `B_ms`'s `edit` (`8` calls, `0` errors) and `write_file` (`7` calls, `0` errors) had a **100% success rate**, whereas `A_baseline`'s `apply_patch` had a **35% failure rate (7/20)** on DeepSeek V4.1 Flash due to unified-diff line-count mismatches.
   - `ms`'s editing primitive is a genuine strength, but its gains were completely erased by `ms exec` forcing extra `read_file(log)` turns.

---

## 6. Recommended Fixes for `ms`

1. **Inline small `ms exec` outputs (e.g., `<= 2 KB` or `<= 40 lines`) directly in the tool response** instead of forcing a `.ms/logs/...` round-trip. Reserve log-file distillation for genuinely large outputs (and still include the last ~20 lines / failing test summary inline).
2. **Make `run_tests` (`ms exec` for pytest) inline the failure trace/summary** so agents never need a follow-up `read_file` on a test log.
3. **Re-evaluate `ms_outline` / `ms_context` / `ms_undo` exposure**: either remove unused `ms_*` tools when they don't beat `read_file` on small repos, or fold structural outline/context into `read_file` / `search_code` responses where the model already looks.
