"""Compare arms over pooled Terminal-Bench lean runs.
  python3 benchmarks/tb/pool.py --cpy RUN... --base RUN...
C_py trials come only from --cpy runs (one frozen bundle); pi/codex from --base runs (versions pinned in run_lean.sh).
Trials that failed before the agent ran (setup/network) are dropped. Tasks weigh equally: pass = mean per-task pass
rate, tokens = mean per-task mean norm over all trials. Each draw takes per-task pass rates from Beta(1+pass, 1+fail)
(a plain bootstrap of 3/3 passes would claim certainty) and tokens from a bootstrap of trials within task x arm;
the draws give the probability that C_py is strictly best."""
import argparse
import random
from collections import defaultdict
from pathlib import Path

from summarize import load, mean

INFRA = {"AgentSetupTimeoutError", "NetworkConnectionError", "EnvironmentStartTimeoutError"}
ARMS = ("C_py", "pi", "codex")

ap = argparse.ArgumentParser()
ap.add_argument("--cpy", nargs="+", required=True)
ap.add_argument("--base", nargs="+", required=True)
ap.add_argument("-b", type=int, default=4000)
args = ap.parse_args()

cells = defaultdict(list)  # (arm, task) -> [(passed, norm)]
for runs, arms in ((args.cpy, {"C_py"}), (args.base, {"pi", "codex"})):
    for run in runs:
        rows = [r for r in load(Path(run)) if r["exc"] not in INFRA]
        for r in rows:
            if r["arm"] in arms:
                cells[(r["arm"], r["task"])].append((r["ok"], r["norm"]))
        if arms == {"C_py"}:
            line = []
            for a in ARMS:
                g = [r for r in rows if r["arm"] == a]
                if g:
                    line.append(f"{a} {sum(r['ok'] for r in g)}/{len(g)} {mean([r['norm'] for r in g]) / 1000:.1f}k")
            print(f"{Path(run).name}: " + " | ".join(line))

tasks = sorted({t for _, t in cells})
missing = [(a, t) for a in ARMS for t in tasks if not cells[(a, t)]]
assert not missing, f"no trials for {missing}"


def stat(rate, pick):
    return {a: (mean([rate(cells[(a, t)]) for t in tasks]), mean([mean([n for _, n in pick(cells[(a, t)])]) for t in tasks])) for a in ARMS}


print(f"\n{'task':28} " + " ".join(f"{a:>18}" for a in ARMS))
for t in tasks:
    print(f"{t:28} " + " ".join(f"{sum(p for p, _ in cells[(a, t)]):>3}/{len(cells[(a, t)]):<3} {mean([n for _, n in cells[(a, t)]]) / 1000:6.1f}k   " for a in ARMS))

point = stat(lambda c: mean([p for p, _ in c]), lambda c: c)
rng = random.Random(0)
boots = [stat(lambda c: rng.betavariate(1 + sum(p for p, _ in c), 1 + sum(not p for p, _ in c)), lambda c: rng.choices(c, k=len(c)))
         for _ in range(args.b)]
print()
for a in ARMS:
    ps = sorted(s[a][0] for s in boots)
    ns = sorted(s[a][1] for s in boots)
    lo, hi = int(0.025 * args.b), int(0.975 * args.b)
    print(f"{a:6} pass {point[a][0]:.1%} [{ps[lo]:.1%}, {ps[hi]:.1%}]   tokens/run {point[a][1] / 1000:.1f}k [{ns[lo] / 1000:.1f}k, {ns[hi] / 1000:.1f}k]")
best_pass = [all(s["C_py"][0] > s[o][0] for o in ARMS[1:]) for s in boots]
best_tok = [all(s["C_py"][1] < s[o][1] for o in ARMS[1:]) for s in boots]
print(f"\nP(C_py best pass) {mean(best_pass):.2f}   P(C_py fewest tokens) {mean(best_tok):.2f}   P(both) {mean([p and q for p, q in zip(best_pass, best_tok)]):.2f}")
