#!/usr/bin/env bash
# Small Terminal-Bench 2.1 A/B: every arm on the same hard tasks, one harbor job per arm, run in parallel.
#   TASKS="fix-ocaml-gc write-compressor" K=1 benchmarks/tb/run_ab.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
DATASET=${DATASET:-/tmp/tb/terminal-bench-2-1}
MODEL=${MODEL:-openai-codex/gpt-6-luna}
TASKS=${TASKS:-fix-ocaml-gc write-compressor make-mips-interpreter fix-code-vulnerability}
OUT=${OUT:-benchmarks/artifacts/tb21-hard-$(date +%Y%m%d-%H%M)}
mkdir -p "$OUT"
include=(); for t in $TASKS; do include+=(-i "$t"); done
for arm in ${ARMS:-A_eight B_one C_py}; do
  PYTHONPATH=benchmarks/tb harbor run -p "$DATASET" "${include[@]}" -a harbor_agent:AxiomArm --ak "arm=$arm" \
    -m "$MODEL" -k "${K:-1}" -n "${N:-2}" -o "$OUT/$arm" > "$OUT/$arm.log" 2>&1 &
done
wait
python3 benchmarks/tb/summarize.py "$OUT"
