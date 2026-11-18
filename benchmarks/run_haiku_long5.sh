#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
rb_commit=210b2d15a373ad265aa721f70199c9962d7de069
export REFACTORBENCH_DIR="${REFACTORBENCH_DIR:?Set REFACTORBENCH_DIR to the RefactorBench checkout}"
test "$(git -C "$REFACTORBENCH_DIR" rev-parse HEAD)" = "$rb_commit"
test -z "$(git -C "$REFACTORBENCH_DIR" status --porcelain)"
export MS_FULL_TRACE=1
out=$(mktemp -d benchmarks/artifacts/haiku-long5.XXXXXX)
model=anthropic/claude-haiku-5-5
printf 'Artifacts: %s\n' "$out"
{
  printf 'Model: %s\nRefactorBench: %s\nms: %s\nAxiom: %s\n' "$model" "$rb_commit" "$(git rev-parse HEAD)" "$(git -C ../nhom-30/axiom-cli rev-parse HEAD)"
  sha256sum benchmarks/ab_single_tool.ts integrations/axiom/{ms-tool,python-repl}.ts ../nhom-30/axiom-cli/src/llm/providers/anthropic.ts "${MS_BIN:-target/release/ms}"
} > "$out/provenance.txt"
cp "$0" "$out/run.sh"

run() {
  local pack=$1 case_id=$2 label=$3 arm=$4 prompt=$5 dir="$out/$2/$3"
  mkdir -p "$dir" || return
  MS_REPL_BATCH_PROMPT="$prompt" bun benchmarks/ab_single_tool.ts --pack "$pack" --cases "$case_id" --trials 1 --max-steps 60 --lean --model "$model" --arms "$arm" --out "$dir" 2>&1 | tee "$dir/live.log" | awk -v label="$case_id/$label" '{print "[" label "] " $0; fflush()}' || return
  jq -e -c -s --arg label "$label" 'select(length == 1) | .[0] | {variant:$label,caseId,overallPassed,agentStatus,llmTurns,toolCalls,toolOutputBytes,promptTokens,cacheWriteTokens,cachedTokens,cacheHitRate,completionTokens,normalizedTotalTokens,wallClockMs,probeOutput,error}' "$dir/runs.jsonl" > "$dir/metrics.json" || return
  jq -e -s 'first.event == "run_start" and last.event == "run_end" and any(.[]; .event == "workspace_diff" and (.data.exitCode == 0 or .data.exitCode == 1)) and ([.[] | select(.event == "model_response")] | length > 0) and ([.[] | select(.event == "model_request" or .event == "model_response" or .event == "model_error")] | group_by(.turn) | all(length == 2 and .[0].event == "model_request"))' "$dir"/traces/*.jsonl >/dev/null || return
  jq -c . "$dir/metrics.json"
}

rc=0
while read -r pack case_id; do
  run "$pack" "$case_id" axiom A_eight 0 & a=$!
  run "$pack" "$case_id" ms-js B_one 0 & b=$!
  run "$pack" "$case_id" repl-control B_repl 0 & c=$!
  run "$pack" "$case_id" repl-batching B_repl 1 & d=$!
  for pid in "$a" "$b" "$c" "$d"; do wait "$pid" || rc=1; done
done <<'CASES'
hard chronos-multistep-gauntlet
refactor refactor-slug-migration
refactorbench flask_refactor/debughelpers-to-helpers.py-test
refactorbench requests_refactor/internal-utils-utils
refactorbench tornado_refactor/options-utils
CASES
fd -I -t f '^metrics\.json$' "$out" -x jq -c . {} > "$out/results.jsonl"
test "$(wc -l < "$out/results.jsonl")" -eq 20 || rc=1
printf 'Artifacts: %s\n' "$out"
exit "$rc"
