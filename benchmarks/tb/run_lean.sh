#!/usr/bin/env bash
# One trial per arm at a time (3 containers): 9 parallel trials froze the dev machine.
# Lean A/B/C on Terminal-Bench 2.1: Axiom C_py vs pi vs Codex CLI, built-in tools only (no extensions, skills, MCP, context files).
#   TASKS="cobol-modernization custom-memory-heap-crash fix-code-vulnerability" K=3 EFFORT=medium benchmarks/tb/run_lean.sh
# pi and codex are version-pinned, so their trials pool across runs: ARMS=C_py N=3 spends all 3 containers on the arm
# under test, then benchmarks/tb/pool.py compares it with the pooled baselines.
set -uo pipefail
cd "$(dirname "$0")/../.."
DATASET=${DATASET:-/tmp/tb/terminal-bench-2-1}
MODEL=${MODEL:-openai-codex/gpt-6-luna}
EFFORT=${EFFORT:-medium}
OUT=${OUT:-benchmarks/artifacts/tb21-lean-$(date +%Y%m%d-%H%M)}
mkdir -p "$OUT"
include=(); for t in $TASKS; do include+=(-i "$t"); done
export PYTHONPATH=benchmarks/tb
ARMS=${ARMS:-C_py pi codex}
has() { [[ " $ARMS " == *" $1 "* ]]; }
common=(-p "$DATASET" "${include[@]}" -m "$MODEL" -k "${K:-3}" -n "${N:-1}")
has C_py && nice -n 15 harbor run "${common[@]}" -a harbor_agent:AxiomArm --ak arm=C_py --ak "effort=$EFFORT" -o "$OUT/C_py" > "$OUT/C_py.log" 2>&1 &
has pi && nice -n 15 harbor run "${common[@]}" -a harbor_agent:LeanPi --ak "thinking=$EFFORT" --ak version=1.5.2 -o "$OUT/pi" > "$OUT/pi.log" 2>&1 &
has codex && nice -n 15 harbor run "${common[@]}" -a harbor_agent:LeanCodex --ak "reasoning_effort=$EFFORT" --ak disable_web_search=true --ak version=0.169.0 -o "$OUT/codex" > "$OUT/codex.log" 2>&1 &
wait
python3 benchmarks/tb/summarize.py "$OUT"
