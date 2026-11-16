# A/B: eight Axiom tools vs one `ms` tool

Model `trollllm/deepseek-v4-1-flash` (TrollLLM, 2026‑11‑16). 3 uc01 bug cases × 3 paired trials = **9 pairs / 18 runs**, counterbalanced AB/BA. Artifacts: [`artifacts/single-tool-deepseek-v4-1-flash/`](artifacts/single-tool-deepseek-v4-1-flash/) (`runs.jsonl`, `summary.json`). Harness: [`ab_single_tool.ts`](ab_single_tool.ts).

- **A_eight** — stock Axiom registry: `run_command, read_file, write_file, edit, apply_patch, list_dir, search_code, run_tests`
- **B_one** — the same workspace, one tool: `ms` ([`integrations/axiom`](../integrations/axiom/README.md))

## Correctness: equal at the ceiling

| | pass | target fixed | regressions | tests weakened | agent errors |
|---|---|---|---|---|---|
| A_eight | **9/9** | 9/9 | 0 | 0 | 0 |
| B_one | **9/9** | 9/9 | 0 | 0 | 0 |

Both arms fixed every case. The measurements below are therefore an efficiency comparison at equal correctness, not a quality win.

Oracle, independent of the agent's workspace: a per-case behavioural probe (`format_tags` on a note without tags → `''`; case-insensitive `Store.search` → 1 hit; `render_table([])` → `''`), the pytest suite against a pristine baseline (new failures and new collection errors are regressions; the fixture's known-broken `test_search_is_case_insensitive` is allowed to stay) and a per-file hash of `tests/` so a weakened test cannot pass as a fix (`__pycache__` excluded).

## Efficiency: paired deltas (B relative to A)

| metric | mean | median | B better in | sign test |
|---|---|---|---|---|
| tool calls | **−50.9%** | −47.1% | **9/9** | p = 0.004 |
| LLM turns | **−21.2%** | −23.1% | **8/9** | p = 0.039 |
| wall clock | −9.1% | −13.0% | 8/9 | p = 0.039 |
| prompt tokens | −22.8% | −40.8% | 6/9 | p = 0.51 |
| total tokens | −20.6% | −35.7% | 6/9 | p = 0.51 |
| completion tokens | **+12.4%** | +11.0% | 4/9 | p = 1.0 |
| tool output bytes | −11.2% | −24.0% | 7/9 | p = 0.18 |

Per case (mean of 3 pairs):

| case | turns | tools | bytes | tokens | wall |
|---|---|---|---|---|---|
| uc01-01 crash-null | −25.0% | −55.0% | −20.5% | −38.7% | −10.9% |
| uc01-02 test-fail | −11.5% | −42.1% | −17.9% | **+21.6%** | −1.2% |
| uc01-03 reproducible | −30.0% | −56.9% | −15.1% | −48.8% | −16.0% |

## What the numbers say

1. **Fewer round trips is the robust effect.** 156 → 74 tool calls over 9 runs, better in every single pair (p = 0.004). One program does read + search + edit + verify that took three or four calls.
2. **One turn less, on average, and one second-glass less.** 8/9 pairs, p = 0.039. The effect is real but small: this model rarely needed more than 15 steps anyway.
3. **Token savings are directional, not proven.** Median total tokens −35.7% but 3 of 9 pairs got worse; case 02 was **+21.6%**. A program is one long message, so prompt tokens fall while **completion tokens rise 12.4%** (4/9 pairs better). Sampling noise on 9 pairs cannot separate −40% from −10%.
4. **No quality cost observed, no quality gain either.** With `max-steps 25` neither arm hit the budget (max 15 vs 10 turns) and neither produced a regression.

## Ceilings of this experiment

- **n = 9 pairs, 3 cases, 1 model, 1 fixture.** Enough for the tool-call effect, not for cost claims. The sign tests are reported instead of a p95 nobody should trust at this size.
- **The arms differ by more than the tool list.** B runs commands through `ms exec` (distilled, journaled) and writes through `ms`'s revision-checked journal; A uses Axiom's `BashTool` + `EditTool`. This measures "one tool + ms runtime" vs "eight tools + stock runtime", not the isolated contribution of hashline or distillation.
- **Known-broken fixture test.** Only `test_search_is_case_insensitive` fails at baseline, so the regression surface is one test. Cases 01 and 03 therefore rely on the behavioural probes, not on the suite.
- **Token accounting is raw provider usage** (`prompt_tokens` / `completion_tokens` / `cached_tokens`), not USD: `deepseek-v4-1-flash` has no entry in the local pricing table, so no cost figure is reported rather than a made-up one.

## Reproduce

```bash
TROLLLLM_API_KEY=... bun benchmarks/ab_single_tool.ts --trials 3 --max-steps 25
# re-aggregate stored runs without calling the model
bun benchmarks/ab_single_tool.ts --recompute benchmarks/artifacts/single-tool-deepseek-v4-1-flash
```

## Headline

> Passing the uc01 bug suite with **half the tool calls** (−50.9%, 9/9 pairs) and **20% fewer turns** (−21.2%, 8/9 pairs), at 9/9 correctness in both arms — while spending 12% **more** completion tokens, because a program is longer than a tool call.

---

# Harder packs (2026‑11‑16, same model)

The three uc01 bug cases were too small to separate the arms: both fixed everything in ~9 turns. Two harder
fixtures were built to reach the workload where a tool list and a code-mode program actually diverge.

## `--pack medium`: taskflow, 4 bugs in 3 subsystems, 124 tests

| arm | pass | required | turns | tools | bytes | tokens | wall |
|---|---|---|---|---|---|---|---|
| A_eight | ✅ | 4/4 | 9 | 19 | 12,794 | 40,357 | 34s |
| B_one | ✅ | 4/4 | 9 | **8** | 18,685 | 35,727 | 38s |

Tools −57.9%, tokens −11.5%, wall +10.8%. **Still too easy**: four independent one-line fixes, both arms
converged to the same turn count. This is the ceiling of bug-fix tasks on a small repo.

## `--pack refactor`: 24-file migration (one shared helper, stricter spec)

Fixture built by [`build_refactor_pack.py`](build_refactor_pack.py): 24 modules each carrying a private copy of
`make_slug()`, plus a spec change (collapse repeated separators, strip edges, non-`[a-z0-9]` runs) and a hidden
test suite kept outside the workspace until grading.

| arm | pass | required | turns | **tools** | bytes | tokens | wall |
|---|---|---|---|---|---|---|---|
| A_eight | ✅ | 4/4 | 19 | **61** | 21,829 | 125,981 | 72s |
| B_one | ✅ | 4/4 | 16 | **15** | 31,106 | 73,640 | 66s |

**Tool calls −75.4%**, turns −15.8%, tokens −41.5%, wall −9.0%, bytes +42.5%.

This is the shape the difference was predicted to have. 61 calls is ~2.5 per file (one read, one edit) — the
tool-per-file tax. 15 calls is the same work batched: one search for the 24 call sites, one atomic
`ms.batch`, one test run. Bytes went *up* because the single tool returns hashline excerpts plus the program's
own output, and the 8-tool arm's `apply_patch` returns almost nothing.

## Fairness of the refactor pack

Verified before spending model calls: a reference solution (`taskflow/core/slugs.py` + patching 24 modules)
turns the suite from 283 → 294 passed with every hidden test green, so the task is achievable exactly as
specified. The hidden tests are applied *after* the run, so the agent can neither read nor weaken them, and
`tests/` + `pytest.ini` are byte-compared before and after.

## Caveats

- **One pair per pack.** These numbers are directional; each is an existence proof that the workload scale
  changed, not a confidence interval.
- **Arms differ by more than the tool list** (ms runtime vs stock BashTool/EditTool), as in the uc01 runs.
- Artifacts: [`artifacts/refactor-deepseek/`](artifacts/refactor-deepseek/).


---

# Aider Polyglot (Exercism, Python) — `--pack exercism`

Published benchmark, external to this repo: `Aider-AI/polyglot-benchmark` (the Exercism set behind Aider's
leaderboard). 20 of the 34 Python exercises, 1 paired trial each = 40 runs, `max-steps 12`.
Artifacts: [`artifacts/polyglot-python-deepseek/`](artifacts/polyglot-python-deepseek/).

## Result

| arm | pass@1 | turns (med) | tools (med) | prompt tokens (med) | failed tool calls | wall (med) |
|---|---|---|---|---|---|---|
| A_eight | **17/20 = 85%** | 8 | 10 | 20,519 | 23 | 36.9s |
| B_one | **19/20 = 95%** | 7 | **6** | **11,170** | **8** | 34.0s |

Paired: both pass 17, **A-only 0**, **B-only 2** (`paasio`, `react`), both fail 1 (`pov`).
McNemar exact, two-sided: **p = 0.50** — not significant at 2 discordant pairs.

Median deltas: turns −12.5%, tool calls **−40.0%**, prompt tokens **−45.6%**, completion tokens −15.2%,
tool output bytes −6.6%, wall −7.8%.

## What this does and does not prove

- **Does**: no exercise was won by the 8-tool arm, and the efficiency gap is consistent (−40% calls, −46%
  prompt tokens, 23 → 8 failed tool calls across 20 tasks). Prompt tokens are where the tool schemas and the
  per-call result pile-up show up.
- **Does not**: pass@1 is not statistically separated. Every failure in both arms ran into the 12-step cap, so
  part of the gap is "finishes inside the budget", not "solves what the other cannot". A larger step budget
  could close it — this run cannot tell.

## Deviations from the published protocol, stated explicitly

- **20 of 34 exercises.** The hardest long tail (`affine-cipher`, `connect`, `dominoes`, `forth`, `poker`,
  `zebra-puzzle`, …) was dropped after a first attempt spent >5 minutes on one exercise and recorded no run.
  The sample is therefore easier than the full set, which flatters both arms.
- **No `instructions.md`.** This checkout ships only the stub and the test file, so the test file is the
  specification. Aider's leaderboard also provides the exercise prose.
- **max-steps 12**, one trial per exercise (paired), single model (`trollllm/deepseek-v4-1-flash`).
- Grading is the exercise's own suite: exit code 0 and at least one test passed, with the test file required to
  be byte-identical afterwards (no tampering observed in any of the 40 runs).


## Correction: the step budget was the whole difference

Re-run with the only variable changed — **`max-steps 20`** instead of 12 — same 20 exercises, same model.

| arm | pass@1 | turns | tools | prompt tok | completion tok | bytes | failed calls | wall |
|---|---|---|---|---|---|---|---|---|
| A_eight | **20/20 = 100%** | 8 | 10 | 19,888 | 2,774 | 14,732 | 19 | 35.6s |
| B_one | **20/20 = 100%** | 7 | **6** | **11,439** | **2,220** | **12,999** | **4** | 31.8s |

Paired: both pass 20, A-only 0, B-only 0, neither 0. **McNemar p = 1.00**, zero discordant pairs.
No run in either arm hit the 20-step cap.

So the 85% → 95% from the 12-step run was **a budget artefact, not a capability gap**: the arms that "lost" had
simply run out of steps. With enough budget both arms solve every exercise in this sample. What survives the
correction is the efficiency profile, and it is unchanged:

| median | 12-step run | 20-step run |
|---|---|---|
| tool calls | −40.0% | **−40.0%** |
| prompt tokens | −45.6% | **−42.5%** |
| completion tokens | −15.2% | −20.0% |
| tool output bytes | −6.6% | −11.8% |
| turns | −12.5% | −12.5% |
| wall | −7.8% | −10.8% |
| failed tool calls (total) | 23 → 8 | **19 → 4** |

Artifacts: [`artifacts/polyglot-python-deepseek-step20/`](artifacts/polyglot-python-deepseek-step20/).

### The honest headline for this pack

> On 20 published Exercism exercises both arms are **20/20**. The single tool does not make the model smarter
> here; it makes the same work cost **40% fewer tool calls, 42% fewer prompt tokens and 13 fewer failed calls**.
> Quality parity, efficiency gain — and the earlier pass-rate difference was a step-budget illusion.

