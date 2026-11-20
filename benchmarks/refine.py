"""Continual-harness refine, offline: C_py trajectories from one task set -> a few general lessons (notes.md) for the R_ref arm.

    python3 benchmarks/refine.py digest OUT      # OUT/digest.md from luna-low C_py fast10 trials
    python3 benchmarks/refine.py --selftest
Then the agent itself writes OUT/notes.md from the digest (see PROMPT); copy it to the bundle as /tmp/abx/notes.md.
Lessons are drawn from fast10 and tested on held-out tasks, so a note cannot carry a test task's answer.
"""
import glob
import json
import os
import re
import sys

ART = os.path.join(os.path.dirname(os.path.abspath(__file__)), "artifacts")
TASKS = "/home/hoang/new_harness_bench/tb21/terminal-bench-2-1"
RUNS = ("tb21-luna-low-fast10", "tb21-luna-low-fast10-n18", "tb21-luna-low-fast10-n12")
PROMPT = ("Read {digest}: trajectories of a coding agent (one persistent python REPL tool) on Terminal-Bench tasks, with pass/fail "
          "and the hidden verifier's errors. Write {notes}: at most 8 lessons that would have turned these failures into passes or "
          "cut wasted turns on OTHER, unseen tasks. One line each, imperative, at most 30 words, ending with (evidence: trial ids). "
          "Only general lessons: no task names, file names, paths or values from these tasks. Skip anything the agent's spec already "
          "says (listed at the top of the digest). Output only the bullet list.")


def clip(text, n):
    text = str(text)
    return text if len(text) <= n else text[:n] + f" …[{len(text) - n} more]"


def verifier_errors(trial_dir, n=6):
    try:
        out = open(os.path.join(trial_dir, "verifier", "test-stdout.txt"), errors="replace").read()
    except OSError:
        return []
    return [clip(line.strip(), 220) for line in out.splitlines() if re.match(r"^(FAILED|E\s{2,})", line)][:n]


def trial_digest(trial_dir, agent, reward):
    tid = os.path.basename(trial_dir).split("__")[-1]
    lines = [f"### {tid} {'PASS' if reward == 1.0 else 'FAIL'} turns={agent['llmTurns']}"]
    if reward != 1.0:
        lines += [f"verifier: {e}" for e in verifier_errors(trial_dir)]
        for t in agent["traces"][-4:]:
            lines.append(f"call(turn {t['turn']}): {clip(json.loads(t['args']).get('code', '') if t['args'].startswith('{') else t['args'], 400)}")
            lines.append(f"  -> {clip(t['output'], 300)}")
    final = next((a["text"] for a in reversed(agent.get("assistant", [])) if a["text"].strip()), "")
    lines.append(f"final reply: {clip(final, 300)}")
    return "\n".join(lines)


def digest(out_dir, spec):
    by_task = {}
    for run in RUNS:
        for f in glob.glob(os.path.join(ART, run, "C_py", "2026-*", "*__*", "agent", "result.json")):
            agent = json.load(open(f))
            if any("usage limit" in r[2] for r in agent.get("retries", [])) or "usage limit" in (agent.get("error") or ""):
                continue  # quota-killed, says nothing about the agent
            trial_dir = f.rsplit("/", 2)[0]
            result = json.load(open(os.path.join(trial_dir, "result.json")))
            reward = ((result.get("verifier_result") or {}).get("rewards") or {}).get("reward")
            by_task.setdefault(os.path.basename(trial_dir).split("__")[0], []).append(trial_digest(trial_dir, agent, reward))
    parts = ["# Agent spec (already known; do not repeat)", spec, ""]
    for task, trials in sorted(by_task.items()):
        instr = clip(open(os.path.join(TASKS, task, "instruction.md")).read(), 600)
        parts += [f"## task {task}", f"instruction: {instr}", *trials, ""]
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "digest.md")
    open(path, "w").write("\n".join(parts))
    return path


def selftest():
    import tempfile
    d = tempfile.mkdtemp()
    os.makedirs(os.path.join(d, "verifier"))
    open(os.path.join(d, "verifier", "test-stdout.txt"), "w").write("ok\nFAILED tests/test_a.py::t - x\nE       AssertionError: 1 != 2\nother\n")
    agent = {"llmTurns": 3, "traces": [{"turn": 2, "args": json.dumps({"code": "print(1)"}), "output": "1"}], "assistant": [{"text": "done"}]}
    text = trial_digest(os.path.join(d, "t__abc"), agent, 0.0).replace("t__abc", "")
    assert "FAIL" in text and "FAILED tests/test_a.py::t" not in text, text  # wrong dir on purpose: no verifier file under t__abc
    os.rename(d, d + "__abc")
    text = trial_digest(d + "__abc", agent, 0.0)
    assert "### abc FAIL turns=3" in text and "verifier: FAILED tests/test_a.py::t - x" in text and "AssertionError" in text
    assert "call(turn 2): print(1)" in text and "final reply: done" in text
    assert "verifier" not in trial_digest(d + "__abc", agent, 1.0)
    print("selftest ok")


if __name__ == "__main__":
    if sys.argv[1:] == ["--selftest"]:
        selftest()
    elif sys.argv[1:2] == ["digest"]:
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        src = open(os.path.join(root, "integrations", "axiom", "cpy.ts")).read()
        spec = re.search(r"export const PYTHON_SYSTEM = \[(.*?)\]\.join", src, re.S).group(1)
        print(digest(sys.argv[2], spec))
    else:
        sys.exit(__doc__)
