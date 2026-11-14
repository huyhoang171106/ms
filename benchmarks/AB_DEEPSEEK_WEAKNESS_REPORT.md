# Controlled A/B Diagnosis: `trollllm/deepseek-v4-1-flash` on Axiom UC01

- **Experiment ID**: `uc01-controlled-seed42-2026-11-14T15-05-32-528Z`
- **Artifacts**: [`benchmarks/artifacts/deepseek-v4-1-flash-t3-seed42/`](./artifacts/deepseek-v4-1-flash-t3-seed42/)
- **Model**: `trollllm/deepseek-v4-1-flash` (`api: openai-completions`, `pricingStatus: unpriced`)
- **Design**: 3 paired trials × 3 UC01 bug cases × 2 arms (`A_baseline` vs `B_ms`) = **18 runs** (`--mode controlled --seed 42 --max-steps 20`)

---

## 1. Executive Summary

- **Verified Pass Rate (`overallPassed`, `targetFixed`, `noRegressions`)**: Both `A_baseline` and `B_ms` achieved **9 / 9 (100.0%)** with **0** infra errors and **0** timeouts.
- **Where `ms` helped**: `B_ms` reduced total tool output bytes by **-51.7%** (`57,852 B` vs `119,829 B`) and total tokens by **-11.7%** (`550,334` vs `622,966`), and `ms` `edit`/`write_file` had **0%** errors (`17/17`) vs `A_baseline`'s `apply_patch` (`2/15` = `13.3%` malformed-diff errors).
- **Where `ms` is weak**: Despite matching `A_baseline`'s 100% pass rate and cutting tokens by 11.7%, `B_ms` required **+21.1% more tool calls (`184` vs `152`)**, **+4.5% more LLM turns (`115` vs `110`)**, and suffered **3.5× more registry-level tool errors (`14` [7.6%] vs `4` [2.6%])**:
  1. **`read_file` errors & call inflation (`70` calls, `11` errors = `15.7%` vs `52` calls, `0` errors in `A_baseline`)**: `8` calls failed with `E_POLICY_DENIED` on `..` path segments and `3` failed with `E_NOT_FOUND` (`skills/bug-fix/SKILL.md`).
  2. **`run_command` call inflation & `ms exec` overhead (`56` calls, `69.4 ms` avg vs `39` calls, `28.4 ms` avg)**: `+43.6%` more shell calls and `2.44×` higher per-call latency (`+41 ms` overhead per `ms exec`).
  3. **Zero adoption of `ms_outline`, `ms_context`, and `ms_undo` (`0` calls across all 9 `B_ms` runs)**: Extra tool schemas were registered but never invoked by DeepSeek V4.1 Flash.

*(Note: An initial run uncovered a benchmark harness bug in `benchmarks/ab_axiom_tools.ts` where `resolvePythonReadableRoots()` only bound `venv/bin` instead of `sys.prefix`, causing `B_ms` `run_tests` to fail with `No module named pytest` inside `bwrap`. That harness bug was fixed and verified with a new unit test before running this 18-run experiment.)*

---

## 2. Aggregate Arm Comparison (`A_baseline` vs `B_ms`)

| Metric | `A_baseline` (9 runs) | `B_ms` (9 runs) | Delta (`B - A`) |
|---|---:|---:|---:|
| Verified Success (`overallPassed`) | **9 / 9 (100%)** | **9 / 9 (100%)** | **0 (0.0 pp)** |
| Target Fixed (`targetFixed`) | 9 / 9 (100%) | 9 / 9 (100%) | 0 (0.0 pp) |
| No Regressions (`noRegressions`) | 9 / 9 (100%) | 9 / 9 (100%) | 0 (0.0 pp) |
| Infra / Timeout Errors | 0 / 0 | 0 / 0 | 0 |
| Total Wall-Clock Time | 576,551.53 ms | 246,525.58 ms | -330,025.95 ms (-57.2%)* |
| Total LLM Turns | 110 | 115 | **+5 (+4.5%)** |
| Total Tool Calls | 152 | 184 | **+32 (+21.1%)** |
| Tool Registry Failures (`isError`) | 4 (2.6%) | **14 (7.6%)** | **+10 (+250%)** |
| Command Non-Zero Exits | 35 | 33 | -2 (-5.7%) |
| Total Tool Output Bytes | 119,829 B | 57,852 B | **-61,977 B (-51.7%)** |
| `uncachedInput` Tokens | 38,319 | 36,702 | -1,617 (-4.2%) |
| `cacheRead` Tokens | 562,944 | 493,184 | -69,760 (-12.4%) |
| `cacheWrite` Tokens | 0 | 0 | 0 |
| `output` Tokens | 21,703 | 20,448 | -1,255 (-5.8%) |
| **Total Tokens** | **622,966** | **550,334** | **-72,632 (-11.7%)** |
| Cost (USD) | `unpriced` (`null`) | `unpriced` (`null`) | `null` |

*\*Wall-clock total in `A_baseline` includes two upstream API latency outliers on `uc01-03-bug-reproducible` (T2 `A_baseline` 102.3s, T3 `A_baseline` 264.4s).*

---

## 3. Paired Deltas by Case (`B_ms - A_baseline`)

| Case ID | Pairs | `passDelta (B - A)` | Median Wall-Clock Delta | Median Turns Delta |
|---|---:|---:|---:|---:|
| `uc01-01-bug-crash-null` | 3 | 0 (3/3 vs 3/3) | -2,280.33 ms | -1 turn |
| `uc01-02-bug-test-fail` | 3 | 0 (3/3 vs 3/3) | -807.38 ms | 0 turns |
| `uc01-03-bug-reproducible` | 3 | 0 (3/3 vs 3/3) | -75,514.07 ms | +1 turn |

Per-trial breakdown:
- `uc01-01-bug-crash-null`:
  - T1 (`BA`): `B` pass (16 turns, 25 tools, 38.1s) vs `A` pass (19 turns, 25 tools, 40.4s)
  - T2 (`BA`): `B` pass (13 turns, 23 tools, 29.9s) vs `A` pass (14 turns, 21 tools, 34.7s)
  - T3 (`AB`): `A` pass (14 turns, 19 tools, 35.7s) vs `B` pass (19 turns, 29 tools, 40.8s)
- `uc01-02-bug-test-fail`:
  - T1 (`AB`): `A` pass (12 turns, 17 tools, 26.8s) vs `B` pass (12 turns, 15 tools, 22.5s)
  - T2 (`AB`): `A` pass (7 turns, 10 tools, 14.6s) vs `B` pass (7 turns, 11 tools, 13.8s)
  - T3 (`BA`): `B` pass (8 turns, 16 tools, 17.5s) vs `A` pass (8 turns, 11 tools, 15.9s)
- `uc01-03-bug-reproducible`:
  - T1 (`AB`): `A` pass (12 turns, 16 tools, 41.8s) vs `B` pass (13 turns, 21 tools, 27.9s)
  - T2 (`BA`): `B` pass (12 turns, 21 tools, 26.8s) vs `A` pass (12 turns, 14 tools, 102.3s)
  - T3 (`AB`): `A` pass (12 turns, 19 tools, 264.4s) vs `B` pass (15 turns, 23 tools, 29.2s)

---

## 4. Tool-Level Breakdown & Exact Errors

### 4.1 Per-Tool Call Volume, Failures, Output Bytes, and Latency

| Tool | `A_baseline` Calls (Err / NZ) | `A_baseline` Avg Bytes / Avg Dur | `B_ms` Calls (Err / NZ) | `B_ms` Avg Bytes / Avg Dur |
|---|---:|---:|---:|---:|
| `list_dir` | 9 (0 / 0) | 205.0 B / 1.6 ms | 9 (0 / 0) | 380.0 B / 2.2 ms |
| `read_file` | 52 (0 / 0) | 1,019.0 B / 1.2 ms | **70** (**11** / 0) | 396.4 B / 1.3 ms |
| `search_code` | 5 (0 / 0) | 143.4 B / 6.6 ms | 2 (0 / 0) | 129.5 B / 2.0 ms |
| `apply_patch` | 15 (**2** / 0) | 70.1 B / 1.1 ms | *not registered* | — |
| `edit` | 3 (0 / 0) | 162.3 B / 1.3 ms | 9 (**0** / 0) | 64.7 B / 1.7 ms |
| `write_file` | 0 (0 / 0) | — | 8 (**0** / 0) | 61.8 B / 2.0 ms |
| `run_command` | 39 (2 / 13) | 780.3 B / 28.4 ms | **56** (3 / 13) | **200.6 B** / **69.4 ms** |
| `run_tests` | 29 (0 / 22) | 1,114.1 B / 155.6 ms | 30 (0 / 20) | **470.4 B** / 157.2 ms |
| `ms_outline` | *n/a* | — | **0** | — |
| `ms_context` | *n/a* | — | **0** | — |
| `ms_undo` | *n/a* | — | **0** | — |

### 4.2 Exact Registry-Level Error Messages

**`B_ms` (14 errors total):**
1. **`read_file` (8×)**: `Error: E_POLICY_DENIED: invalid path: parent directory traversal ('..') is not allowed (Use a relative UTF-8 path inside the workspace root without '..' or symlinks.)`
2. **`read_file` (3×)**: `Error: E_NOT_FOUND: not found: path not found: 'skills/bug-fix/SKILL.md'`
3. **`run_command` (3×)**: `Blocked by policy (shell references a path outside the workspace). This action is never allowed; do not retry it in another form.`

**`A_baseline` (4 errors total):**
1. **`apply_patch` (2×)**: malformed unified diff (`invalid diff at line 9: unexpected line in hunk...`, `invalid diff at line 21: unexpected line in hunk...`)
2. **`run_command` (2×)**: `Blocked by policy (shell references a path outside the workspace). This action is never allowed; do not retry it in another form.`

---

## 5. Concrete `ms` Weaknesses Observed in Traces

1. **`ms` `read_file` `E_POLICY_DENIED` on `..` path segments (`8/70` = `11.4%` of all `B_ms` reads)**:
   - `B_ms` suffered **11 `read_file` errors** vs **0** in `A_baseline`, led by 8 `E_POLICY_DENIED` rejections whenever the model passed a path containing `..` (even when normalized path stays inside the workspace, or when probing parent paths).
2. **`run_command` call inflation (`+43.6%`: 56 vs 39) and `2.44×` `ms exec` latency (`69.4 ms` vs `28.4 ms`)**:
   - `B_ms` `run_command` returned **200.6 B** avg vs **780.3 B** in `A_baseline` (-74.3%), and DeepSeek V4.1 Flash issued 17 more `run_command` calls in `B_ms` than in `A_baseline`, incurring ~41 ms extra `ms exec` startup/distillation overhead per call.
3. **Zero adoption of `ms_outline`, `ms_context`, and `ms_undo` (`0` calls across all 9 `B_ms` runs)**:
   - DeepSeek V4.1 Flash never once called `ms_outline`, `ms_context`, or `ms_undo`, relying exclusively on `list_dir`, `read_file`, `search_code`, `run_tests`, `run_command`, `edit`, and `write_file`. Registering unused `ms_*` tools adds schema tokens without influencing agent behavior.
4. **Net tool-call & turn overhead (`+21.1%` tool calls, `+4.5%` turns)**:
   - Even with `run_tests` working cleanly (`470.4 B` vs `1,114.1 B`, -57.8% bytes, same ~157 ms latency) and `edit`/`write_file` achieving 100% accuracy (0 errors vs 2 `apply_patch` errors in `A_baseline`), `B_ms` still used 32 more tool calls and 5 more LLM turns overall.

---

## 6. Recommended Fixes for `ms`

1. **Normalize `..` in `ms` path validation before checking workspace containment** (if a path like `tests/../tinydb_demo/store.py` resolves inside the workspace root, allow it; only reject paths that actually escape the workspace root).
2. **Inline small `ms exec` command outputs without distillation overhead** or reduce `ms exec` per-invocation latency (`69.4 ms` vs `28.4 ms`).
3. **Prune or fold `ms_outline` / `ms_context` / `ms_undo`**: on small/medium Python repos, models ignore standalone `ms_*` tools; either omit them from the default toolset or fold structural context into `read_file`/`search_code`.
