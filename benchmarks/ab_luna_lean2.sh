#!/usr/bin/env bash
set -uo pipefail
cd /home/hoang/ms
OUT=${OUT:-benchmarks/artifacts/ab-luna-lean2}
rm -rf "$OUT"; mkdir -p "$OUT/logs"; export OUT
run() {
  local arm=$1
  AXIOM_REASONING_EFFORT=low bun benchmarks/ab_single_tool.ts --pack uc01 --trials "${TRIALS:-3}" \
    --model openai-codex/gpt-6-luna --arms "$arm" --lean --out "$OUT/$arm" > "$OUT/logs/$arm.log" 2>&1
}
run A_eight & a=$!
run B_one & b=$!
wait "$a" "$b"
echo '=== A ==='; tail -3 "$OUT/logs/A_eight.log"
echo '=== B ==='; tail -3 "$OUT/logs/B_one.log"
