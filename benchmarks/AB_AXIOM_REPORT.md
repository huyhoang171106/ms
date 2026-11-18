# A/B Test Report: Axiom Baseline vs. Axiom + `ms` on `evals/uc01/`

## 1. Controlled Smoke Run (`v2.0.0` Harness, `N=1` Paired Trial/Case, Seed `42`)

- **Date**: 2026-11-14
- **Experiment ID**: `uc01-controlled-seed42-2026-11-14T14-25-21-822Z`
- **Model**: `anthropic/claude-haiku-5-5` (resolved pricing key: `claude-haiku-5.5`; **estimated cost** using `in=$0.10/1M`, `cacheRead=$0.02/1M`, `cacheWrite_5m=$0.125/1M`, `out=$0.50/1M`, source: `nhom-30/src/llm/cost-tracker.ts` + Anthropic 1.25x 5m cache-write multiplier, as of `2026-11-14`)
- **Mode & Execution Policy**: `--mode controlled` (both arms use `/bin/bash`, `scrubEnv`, `bwrap` sandbox, `120,000 ms` timeout, `validatePytestTarget`, `destructiveReason`, and `allowWithoutApprover: true`)
- **Counterbalancing**: Deterministic AB/BA pairing + case shuffle (`--seed 42`): `uc01-03` (`AB`), `uc01-01` (`BA`), `uc01-02` (`AB`)
- **Fixture**: `/home/hoang/nhom-30/evals/fixtures/uc01/` (**8 files** total including `README.md` and `tests/test_search.py`; 6 Python files under `tinydb_demo/`)
- **Artifacts**: [`artifacts/smoke-controlled-seed42/summary.json`](artifacts/smoke-controlled-seed42/summary.json), [`artifacts/smoke-controlled-seed42/manifest.json`](artifacts/smoke-controlled-seed42/manifest.json), [`artifacts/smoke-controlled-seed42/runs.jsonl`](artifacts/smoke-controlled-seed42/runs.jsonl), `traces/*.json`, `patches/*.diff`

### Controlled Smoke Summary (`N=1` per case — smoke verification only, not statistically powered)

| Metric | Arm A (`A_baseline`) | Arm B (`B_ms`) | Delta (B vs A) |
|---|---:|---:|---:|
| **Target checks passed** | **3 / 3** | **3 / 3** | `0` |
| **No-regression oracle passed** | **3 / 3** | **3 / 3** | `0` |
| **Overall verified success** | **3 / 3** | **3 / 3** | `0` |
| **Infra errors / Timeouts** | `0` / `0` | `0` / `0` | `0` |
| **Total Wall-Clock Time** | `43,707.49 ms` | `79,013.76 ms` | `+80.8%` |
| **Total LLM Turns** | `22` | `34` | `+54.5%` |
| **Total Tool Calls** | `32` | `48` | `+50.0%` |
| **Registry-level invocation errors** | `0` | `3` | `+3` |
| **Command/test non-zero exits** | `5` | `10` | `+5` |
| **Total Tool Output Bytes** | `24,424 B` | `9,659 B` | `-60.5%` |
| **Uncached Input Tokens** | `887` | `911` | `+2.7%` |
| **Cache Read Tokens** | `94,695` | `161,867` | `+70.9%` |
| **Cache Write Tokens** | `16,793` | `15,660` | `-6.7%` |
| **Output Tokens** | `6,940` | `12,642` | `+82.2%` |
| **Estimated Cost (USD)** | **`$0.007551`** | **`$0.011607`** | **`+53.7%`** |
| **Estimated Cost / Verified Success** | `$0.002517` | `$0.003869` | `+53.7%` |

### Controlled Smoke Per-Task Breakdown

| Case | Pair Order | Arm | Overall / Target / NoReg | Wall Time (ms) | Turns | Tools (RegErr / CmdNZ) | Output Bytes | Est. Cost (USD) | Trace / Patch |
|---|---|---|---|---:|---:|---:|---:|---:|---|
| `uc01-03-bug-reproducible` | AB | A | PASS / true / true | 13,183.24 | 7 | 9 (0 / 2) | 7,764 | $0.002058 | [trace](artifacts/smoke-controlled-seed42/traces/trial-1__uc01-03-bug-reproducible__A_baseline.json) / [diff](artifacts/smoke-controlled-seed42/patches/trial-1__uc01-03-bug-reproducible__A_baseline.diff) |
| `uc01-03-bug-reproducible` | AB | B | PASS / true / true | 9,975.66 | 6 | 8 (0 / 1) | 1,732 | $0.001520 | [trace](artifacts/smoke-controlled-seed42/traces/trial-1__uc01-03-bug-reproducible__B_ms.json) / [diff](artifacts/smoke-controlled-seed42/patches/trial-1__uc01-03-bug-reproducible__B_ms.diff) |
| `uc01-01-bug-crash-null` | BA | B | PASS / true / true | 36,907.70 | 13 | 21 (1 / 5) | 4,078 | $0.005439 | [trace](artifacts/smoke-controlled-seed42/traces/trial-1__uc01-01-bug-crash-null__B_ms.json) / [diff](artifacts/smoke-controlled-seed42/patches/trial-1__uc01-01-bug-crash-null__B_ms.diff) |
| `uc01-01-bug-crash-null` | BA | A | PASS / true / true | 19,771.40 | 9 | 14 (0 / 2) | 10,858 | $0.003509 | [trace](artifacts/smoke-controlled-seed42/traces/trial-1__uc01-01-bug-crash-null__A_baseline.json) / [diff](artifacts/smoke-controlled-seed42/patches/trial-1__uc01-01-bug-crash-null__A_baseline.diff) |
| `uc01-02-bug-test-fail` | AB | A | PASS / true / true | 10,752.85 | 6 | 9 (0 / 1) | 5,802 | $0.001984 | [trace](artifacts/smoke-controlled-seed42/traces/trial-1__uc01-02-bug-test-fail__A_baseline.json) / [diff](artifacts/smoke-controlled-seed42/patches/trial-1__uc01-02-bug-test-fail__A_baseline.diff) |
| `uc01-02-bug-test-fail` | AB | B | PASS / true / true | 32,130.40 | 15 | 19 (2 / 4) | 3,849 | $0.004648 | [trace](artifacts/smoke-controlled-seed42/traces/trial-1__uc01-02-bug-test-fail__B_ms.json) / [diff](artifacts/smoke-controlled-seed42/patches/trial-1__uc01-02-bug-test-fail__B_ms.diff) |

- **Baseline suite note**: The unpatched `uc01` fixture has 1 pre-existing failing test (`tests/test_search.py::test_search_is_case_insensitive`). The external oracle (`ab_axiom_oracle.ts`) allows that specific pre-existing failure on `uc01-01` and `uc01-03` while rejecting any new test failures, collection errors (`exit 2`), skipped/deleted/weakened tests, or broken healthy invariants (`Store.search`, `Store.add`/`save`/reload, `format_tags` with existing tags, multi-row `render_table`).

### Safety & Scope Clarifications

- **Unattended policy**: Both arms run with `registry.allowWithoutApprover = true` and `bwrap` sandboxing (`--mode controlled`).
- **Scope of `ms` guarantees**: `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)`, BLAKE3 revision checks, WAL journaling, and Axiom's `test-guard` (`findChangeTampering`) apply **only to `ms` RPC file operations** (`read`, `edit`, `write_file`, `delete_file`, `rename_file`, `tx.undo`). Arbitrary shell commands executed via `run_command` / `ms exec` can modify files directly without passing through WAL, `openat2`, or `edit` tool `test-guard`.

---

## 2. Historical Pilot Snapshot (`N=1`, Pre-Fix Harness — Deprecated Accounting)

> **Historical Pilot Notice**: The run below (`2026-11-14T13:48:51Z`, [`ab_axiom_uc01_results.json`](ab_axiom_uc01_results.json)) was a `N=1` pilot with fixed A-before-B ordering, native `ms exec` differences (`sh` vs `/bin/bash`, 60s vs 120s, unscrubbed env), and **flawed USD accounting** (`claude-haiku-5-5` fell back to `default` pricing `{input:2, output:8, cacheRead:0.5}` and `CostTracker` clamped `cached <= prompt` while subtracting cache from already-uncached `input_tokens`). Do **not** use the USD figures below for decision-making.

- **Date**: 2026-11-14 (`2026-11-14T13:48:51Z`)
- **Harness**: `ab_axiom_uc01.ts` (v1, pre-fix)
- **Raw Results**: [`ab_axiom_uc01_results.json`](ab_axiom_uc01_results.json)

| Metric | Arm A (`A_baseline`) | Arm B (`B_ms`) | Delta (B vs A) |
|---|---:|---:|---:|
| **Target checks passed** | **3 / 3 (100%)** | **3 / 3 (100%)** | `0` |
| **Total Wall-Clock Time** | `34,477 ms` | `74,460 ms` | `+116.0%` |
| **Total LLM Turns** | `19` | `31` | `+63.2%` |
| **Total Tool Calls** | `24` | `43` | `+79.2%` |
| **Registry-level invocation errors** | `0` | `0` | `0` |
| **Input Tokens (uncached)** | `881` | `905` | `+2.7%` |
| **Cache Read Tokens** | `68,261` | `148,297` | `+117.2%` |
| **Output Tokens** | `5,453` | `11,450` | `+110.0%` |
| **Estimated Cost (USD, flawed v1 tracker)** | `$0.044064` | `$0.092053` | `+108.9%` |

## 3. Observations & Hypotheses (Pilot)

1. **Tool output distillation vs. turn count**: Across the controlled smoke run, `ms exec` reduced total tool output bytes by `60.5%` (`9,659 B` vs `24,424 B`), yet Arm B still took more turns on `uc01-01` and `uc01-02` (`13` vs `9` and `15` vs `6`), while beating Arm A on `uc01-03` (`6` vs `7` turns). Single-run (`N=1`) variance is high; at least `10` paired trials per case are needed before drawing causal conclusions.
2. **Schema & hashline overhead on tiny files**: `evals/fixtures/uc01` (`tinydb_demo`) is an **8-file** repository where the target files are 2, 8, and 17 lines long. Arm B exposed 10 tool schemas (including `ms_outline`, `ms_context`, `ms_undo`) vs. Arm A's 8.
3. **Next step**: Run a `>= 10` paired-trial pilot with `--mode controlled --seed 42 --trials 10` and single-factor ablations (e.g., distilled exec only, hashline read/edit only, minimal tool set) to isolate which component drives turn count and cost. **Done — see section 4 below: the pilot's byte and cost claims do not replicate.**

## 4. Thirty-pair follow-up (2026-11-15, `--mode controlled --trials 10`)

The pilot above asked for at least 10 paired trials per case before drawing conclusions. That run exists:
`benchmarks/artifacts/claude-haiku-5-5-v4fix3-t10-seed42` — `claude-haiku-5-5`, 3 cases × 10 trials × 2 arms = 60 runs,
**60/60 completed, 60/60 verified pass in both arms, 0 infra errors, 0 timeouts**, cost priced (`costDollars` present for
both arms).

Re-analysis with paired bootstrap (20,000 resamples, seed 42) via
`python3 benchmarks/paired_bootstrap.py benchmarks/artifacts/claude-haiku-5-5-v4fix3-t10-seed42`:

| metric | mean delta (B vs A) | 95% bootstrap CI | median | better in | sign test p |
|---|---:|---|---:|---:|---:|
| turns | +1.9% | [-4.8%, +9.4%] | +0.0% | 11/30 | 0.824 |
| tool calls | +6.1% | [-2.8%, +15.5%] | +9.1% | 10/30 | 0.424 |
| tool output bytes | +7.3% | [-9.2%, +24.3%] | +9.9% | 12/30 | 0.362 |
| wall clock | **+19.5%** | **[+7.5%, +32.8%]** | +18.1% | 9/30 | 0.043 |
| total tokens | +6.0% | [-6.1%, +19.4%] | +2.1% | 14/30 | 0.856 |
| cost (USD) | +9.4% | [-1.3%, +20.5%] | +15.1% | 11/30 | 0.265 |

Aggregate totals agree: `A_baseline` 211 turns / 289 tool calls / 148,686 B / `$0.05642`; `B_ms` 214 turns / 301 tool
calls / 127,353 B / `$0.06285`; wall clock 369,233.73 ms vs 423,850.72 ms.

**Conclusions that replace the pilot's:**

1. The `N=1` claims in sections 1–2 (`-60.5%` bytes, `+53.7%` cost) do not replicate. At 30 pairs the multi-tool `ms`
   integration is neutral on turns/tokens/cost and **significantly slower in wall clock**.
2. Registering `ms` as 10 separate `ms_*` tools is the wrong shape. The measured win appears only after the collapse to
   one `ms` tool — see [`AB_SINGLE_TOOL_REPORT.md`](AB_SINGLE_TOOL_REPORT.md) (tool calls `-50.9%`, CI
   `[-56.4%, -45.0%]`, 9/9 pairs).
3. Hypothesis 2 in section 3 (extra schemas on tiny files) is supported by this run's wall-clock regression, but the
   experiment still cannot separate schema count from `ms exec` overhead. Only the single-tool ablation above isolates
   the tool-list change.

