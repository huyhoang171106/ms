#!/usr/bin/env python3
"""Paired bootstrap CI + exact sign test over stored A/B run artifacts.

Reads <artifact>/runs.jsonl (both schema 1.x and 2.x metric names), pairs runs by
(caseId, trial), and reports relative deltas of the treatment arm vs the baseline.
No model calls: re-analysis of artifacts already on disk.

    python3 benchmarks/paired_bootstrap.py benchmarks/artifacts/<dir>
    python3 benchmarks/paired_bootstrap.py --selftest
"""
import argparse
import json
import random
import sys
from math import comb
from pathlib import Path

METRICS = {
    "turns": ["llmTurns"],
    "tools": ["toolCalls", "toolCallsTotal"],
    "bytes": ["toolOutputBytes", "toolOutputBytesTotal"],
    "wall": ["wallClockMs"],
    "tokens": ["totalTokens", "usage.totalTokens"],
    "cost": ["costDollars"],
}


def get(row, path):
    cur = row
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def metric_value(row, name):
    for path in METRICS[name]:
        value = get(row, path)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
    if name == "tokens":
        # Schema 1.x stores the halves, not the sum.
        parts = [get(row, "promptTokens"), get(row, "completionTokens")]
        if any(isinstance(part, (int, float)) for part in parts):
            return float(sum(part for part in parts if isinstance(part, (int, float))))
    return None


def load_pairs(runs_paths, arms_wanted=None):
    rows = []
    for runs_path in runs_paths:
        rows += [json.loads(line) for line in runs_path.read_text().splitlines() if line.strip()]
    arms = sorted({row.get("arm") for row in rows if row.get("arm")})
    if arms_wanted:
        missing = [arm for arm in arms_wanted if arm not in arms]
        if missing:
            raise SystemExit(f"missing arm(s) {missing}; found {arms}")
        arms = list(arms_wanted)
        rows = [row for row in rows if row.get("arm") in arms]
    if len(arms) != 2:
        raise SystemExit(f"expected 2 arms, found {arms}; pass --arms BASE,TREAT")
    cells = {}
    for row in rows:
        cells.setdefault((row.get("caseId"), row.get("trial")), {})[row.get("arm")] = row
    pairs = [
        (cell[arms[0]], cell[arms[1]])
        for cell in cells.values()
        if len(cell) == 2 and not any(is_unscored(row) for row in cell.values())
    ]
    return arms, pairs


def is_unscored(row):
    """Drops infra errors and timeouts: their zeroed counters would fake a fast run."""
    status = str(row.get("status") or row.get("agentStatus") or "").lower()
    return bool(row.get("infraError")) or "error" in status or "timeout" in status


def relative_deltas(pairs, name):
    out = []
    for base_row, treat_row in pairs:
        base, treat = metric_value(base_row, name), metric_value(treat_row, name)
        if base and treat is not None and base > 0:
            out.append((treat - base) / base)
    return out


def bootstrap_ci(deltas, iters=20000, seed=42, alpha=0.05):
    rng = random.Random(seed)
    n = len(deltas)
    means = sorted(
        sum(rng.choices(deltas, k=n)) / n for _ in range(iters)
    )
    return means[int(alpha / 2 * iters)], means[int((1 - alpha / 2) * iters) - 1]


def sign_test_p(deltas):
    nonzero = [d for d in deltas if d != 0]
    n, wins = len(nonzero), sum(1 for d in nonzero if d > 0)
    if n == 0:
        return 1.0
    tail = sum(comb(n, k) for k in range(0, min(wins, n - wins) + 1))
    return min(1.0, 2 * tail / 2 ** n)


def summarize(pairs, iters, seed):
    lines = [
        "| metric | mean delta | 95% bootstrap CI | median | better in | sign test p |",
        "|---|---:|---|---:|---:|---:|",
    ]
    for name in METRICS:
        deltas = relative_deltas(pairs, name)
        if len(deltas) < 2:
            continue
        lo, hi = bootstrap_ci(deltas, iters=iters, seed=seed)
        ordered = sorted(deltas)
        median = ordered[len(ordered) // 2]
        better = sum(1 for d in deltas if d < 0)
        lines.append(
            f"| {name} | {100 * sum(deltas) / len(deltas):+.1f}% | "
            f"[{100 * lo:+.1f}%, {100 * hi:+.1f}%] | {100 * median:+.1f}% | "
            f"{better}/{len(deltas)} | {sign_test_p(deltas):.3f} |"
        )
    return "\n".join(lines)


def selftest():
    pairs = [
        ({"llmTurns": 10}, {"llmTurns": 5}),
        ({"llmTurns": 20}, {"llmTurns": 10}),
        ({"llmTurns": 4}, {"llmTurns": 2}),
    ]
    deltas = relative_deltas(pairs, "turns")
    assert deltas == [-0.5, -0.5, -0.5], deltas
    lo, hi = bootstrap_ci(deltas, iters=200)
    assert abs(lo + 0.5) < 1e-9 and abs(hi + 0.5) < 1e-9, (lo, hi)
    assert sign_test_p(deltas) == 2 * (1 / 2 ** 3) * 1  # all three wins, n=3
    assert metric_value({"toolCallsTotal": 7}, "tools") == 7.0
    assert metric_value({"usage": {"totalTokens": 9}}, "tokens") == 9.0
    assert metric_value({"costDollars": None}, "cost") is None
    print("selftest ok")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact", nargs="*", help="artifact directory or runs.jsonl (repeat to merge files)")
    parser.add_argument("--arms", help="comma-separated BASE,TREAT when a file holds more than two arms")
    parser.add_argument("--iters", type=int, default=20000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    if args.selftest:
        return selftest()
    runs = []
    for raw in args.artifact:
        path = Path(raw)
        if path.is_dir():
            # A/B and third-arm runs can sit in one dir, or one subdir per arm.
            runs += sorted(path.rglob("runs*.jsonl"))
        else:
            runs.append(path)
    if not runs:
        parser.error(f"no runs*.jsonl under {args.artifact}")
    arms, pairs = load_pairs(runs, args.arms.split(",") if args.arms else None)
    print(f"# {', '.join(str(r) for r in runs)}  arms: {arms[0]} (baseline) vs {arms[1]} (treatment), {len(pairs)} pairs\n")
    if not pairs:
        print("no scorable pairs (every pair hit an infra error or timeout)")
        return 1
    print(summarize(pairs, args.iters, args.seed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
