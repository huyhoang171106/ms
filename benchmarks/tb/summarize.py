"""Tables for a run_ab.sh output dir: per trial, per task x arm, and per arm pooled.
norm = prompt + cacheRead + cacheWrite + completion (unweighted, same as normalizedTotalTokens in usage_single_tool.ts);
norm(passed) averages passed trials only, norm(all) every trial."""
import json
import sys
from collections import defaultdict
from pathlib import Path


def load(root):
    rows = []
    for trial in sorted(root.glob("*/*/*__*/result.json")):
        arm = trial.parts[len(root.parts)]
        r = json.loads(trial.read_text())
        agent = trial.parent / "agent" / "result.json"
        a = json.loads(agent.read_text()) if agent.exists() else {}
        reward = ((r.get("verifier_result") or {}).get("rewards") or {}).get("reward")
        exc = (r.get("exception_info") or {}).get("exception_type", "")
        u = a.get("usage", {})
        tok = {k: u.get(k, 0) for k in ("prompt", "cacheRead", "cacheWrite", "completion")}
        if a and not str(a.get("model", "")).startswith("anthropic/"):
            # Axiom's Responses/OpenAI-style providers (wireUsage) count cached input inside promptTokens; its anthropic
            # provider does not. Make prompt uncached-only so norm counts each input token once.
            tok["prompt"] -= tok["cacheRead"] + tok["cacheWrite"]
        if not a:  # harbor-native agent (pi, codex): n_input_tokens includes cached input
            h = r.get("agent_result") or {}
            cached = h.get("n_cache_tokens") or 0
            tok = dict(prompt=(h.get("n_input_tokens") or 0) - cached, cacheRead=cached, cacheWrite=0, completion=h.get("n_output_tokens") or 0)
            traj = trial.parent / "agent" / "trajectory.json"
            steps = json.loads(traj.read_text()).get("steps", []) if traj.exists() else []
            a = {"status": "-", "llmTurns": sum(s.get("source") == "agent" for s in steps)}
        rows.append(dict(task=r.get("task_name", trial.parent.name).split("/")[-1], arm=arm, ok=reward == 1, reward=reward,
                         status=a.get("status", "-"), turns=a.get("llmTurns", 0), calls=a.get("toolCalls", 0),
                         wall=a.get("wallMs", 0) // 1000, exc=exc, norm=sum(tok.values()), trial=trial.parent, **tok))
    return rows


def mean(xs):
    return sum(xs) / len(xs) if xs else 0


def main(rows):
    print(f"{'task':28} {'arm':8} {'reward':>6} {'status':10} {'turns':>5} {'calls':>5} {'norm':>9} {'wall_s':>6} exception")
    for t in sorted(rows, key=lambda r: (r["task"], r["arm"])):
        print(f"{t['task']:28} {t['arm']:8} {str(t['reward']):>6} {t['status']:10} {t['turns']:>5} {t['calls']:>5} {t['norm']:>9} {t['wall']:>6} {t['exc']}")
    groups = defaultdict(list)
    for r in rows:
        groups[(r["task"], r["arm"])].append(r)
    print(f"\n{'task':28} {'arm':8} {'pass':>5} {'turns':>6} {'norm_passed':>11}")
    for (task, arm), g in sorted(groups.items()):
        ok = [r for r in g if r["ok"]]
        print(f"{task:28} {arm:8} {len(ok)}/{len(g):<3} {mean([r['turns'] for r in g]):6.2f} {int(mean([r['norm'] for r in ok])) if ok else '-':>11}")
    print()
    for arm in sorted({r["arm"] for r in rows}):
        g = [r for r in rows if r["arm"] == arm]
        ok = [r for r in g if r["ok"]]
        parts = " ".join(f"{k} {int(mean([r[k] for r in ok])):,}" for k in ("cacheRead", "cacheWrite", "prompt", "completion"))
        print(f"{arm}: pass {len(ok)}/{len(g)}, turns {mean([r['turns'] for r in g]):.2f}, norm(all) {int(mean([r['norm'] for r in g])):,}, "
              f"norm(passed) {int(mean([r['norm'] for r in ok])):,} [{parts}]")


if __name__ == "__main__":
    main(load(Path(sys.argv[1])))
