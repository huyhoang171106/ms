# Prime-style Axiom: does it save tokens? (2026-11-21)

Question: do Prime Agent ideas cut $/pass >=15% vs C_py without losing >5 pts pass rate?
All runs: Terminal-Bench 2.1, 3 trials/task, 12 containers, `stall_ms=45000`. Summaries: `python3 benchmarks/rref_report.py PRICE DIR...`.

## H1: `llm(prompt, ctx)` sub-model call from the REPL (arm R_llm) -- stopped
- Pilot luna-low, 3 heavy tasks x2: **0 llm() calls in 6 trials** (local smoke proved the RPC works).
- Upper bound from 30 C_py luna-low traces, offloading every >4k output: **3.4% saving/trial**. Resent history is cached (cacheRead = ~12% of cost), so moving big outputs out of context saves little. `spawn()`/fork stage skipped.

## H2: offline refine -> `notes.md` lessons (arm R_ref) -- no effect
Notes v1 (`artifacts/rlm-s4/notes.md`, 6 lines) written by the agent from fast10 C_py traces; tested on 10 held-out tasks.

| run | C_py | R_ref | diff, p |
|---|---|---|---|
| luna-low held-out, run 1 | 12/30 = 40% | 16/30 = 53% | +13, p~0.3 |
| luna-low held-out, run 2 | 18/29 = 62% | 14/30 = 47% | -15, p=0.24 |
| **luna-low combined** | **30/59 = 51%** | **30/60 = 50%** | **-0.8, p=0.93** |
| haiku-5.5 low held-out | 23/30 = 77% | 22/30 = 73% | -3, p=0.77 |
| haiku-5.5 low fast10 (regression) | 25/30 = 83% | 26/30 = 87% | +3, p=0.72 |

R_ref $/trial is equal or ~10% higher (haiku). The first run's +13 pts was noise: per-task swings of 3/3 vs 0/3 flip between runs.

## Decision
Not porting llm()/spawn()/notes into axiom-cli. Arms R_llm and R_ref stay in `benchmarks/tb/runner.ts` for reuse.

## Bigger lever found on the way
Prompt cache: luna-low cache hit ~64%; 18-20% of cacheable turns miss on **all** arms although `prompt_cache_key` + `session-id` are sent. Uncached prompt is ~52% of cost, so fixing cache misses beats every Prime idea measured here. Backend headers expose no sticky-routing token; cause unresolved.

## Variance note
With 30 trials/arm, +-15 pts is within noise on these tasks. Use >=60 trials/arm (or paired per-task tests) before calling a winner.
