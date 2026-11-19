#!/usr/bin/env bash
# Runs the three uc01 arms at the same time, one live log per arm plus a shared status board.
#
#   TRIALS=3 ./benchmarks/three_arm_run.sh
#   tail -f benchmarks/artifacts/ab-luna-lean/logs/*.log      # raw stream
#   watch -n1 cat benchmarks/artifacts/ab-luna-lean/STATUS.md # one-screen status
#
# LEAN=1 (default) strips external context on both sides:
#   pi arm     -> -ne -ns -np -nc   (no extensions, skills, prompt templates, AGENTS.md)
#   Axiom arms -> --lean            (base system prompt only, no skills index/rules/memory)
# Wall clock is NOT comparable across arms here: they share CPU and network.
set -uo pipefail
cd "$(dirname "$0")/.."

OUT=${OUT:-benchmarks/artifacts/ab-luna-lean}
MODEL=${MODEL:-openai-codex/gpt-6-luna}
THINKING=${THINKING:-low}
TRIALS=${TRIALS:-1}
CASES=${CASES:-}
LEAN=${LEAN:-1}
mkdir -p "$OUT/logs"
STATUS="$OUT/STATUS.md"
: >"$STATUS"

case_flag=()
[ -n "$CASES" ] && case_flag=(--cases "$CASES")
lean_flag=()
[ "$LEAN" = "1" ] && lean_flag=(--lean)

arm_ab() {
  local arm=$1
  stdbuf -oL -eL \
    bun benchmarks/ab_single_tool.ts --pack uc01 --trials "$TRIALS" --model "$MODEL:$THINKING" --arms "$arm" "${case_flag[@]}" "${lean_flag[@]}" --out "$OUT/$arm" 2>&1 \
    | stdbuf -oL tee -a "$OUT/logs/$arm.log"
}

arm_pi() {
  stdbuf -oL -eL \
    bun benchmarks/ab_pi_arm.ts --trials "$TRIALS" --model "$MODEL" --thinking "$THINKING" "${case_flag[@]}" "${lean_flag[@]}" --out "$OUT/C_pi" 2>&1 \
    | stdbuf -oL tee -a "$OUT/logs/C_pi.log"
}

board() {
  local state=$1
  {
    echo "# 3-arm run — $MODEL, thinking=$THINKING, trials=$TRIALS, lean=$LEAN"
    echo
    echo "started $START · state $state"
    echo
    echo "| arm | runs | last event |"
    echo "|---|---:|---|"
    for arm in A_eight B_one C_pi; do
      local log="$OUT/logs/$arm.log"
      local runs
      runs=$(cat "$OUT/$arm"/runs*.jsonl 2>/dev/null | wc -l)
      local last
      last=$(grep -E '^(PASS|FAIL)' "$log" 2>/dev/null | tail -1 | cut -c1-140)
      [ -z "$last" ] && last=$(tail -1 "$log" 2>/dev/null | cut -c1-140)
      echo "| $arm | $runs | ${last:-starting…} |"
    done
  } >"$STATUS"
}

START=$(date +%H:%M:%S)
board "running"
arm_ab A_eight & local_a=$!
arm_ab B_one & local_b=$!
arm_pi & local_c=$!

while kill -0 "$local_a" 2>/dev/null || kill -0 "$local_b" 2>/dev/null || kill -0 "$local_c" 2>/dev/null; do
  board "running"
  sleep 2
done
wait
board "done"
cat "$STATUS"
