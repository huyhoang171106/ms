#!/usr/bin/env bash
# Arms per task are listed in task(); edit that list for each A/B (see loop.md).
# tasks x arms x TRIALS; TASKS_PARALLEL tasks at once, the arms of a task in parallel.
# run args: pack case label arm MS_REPL_BATCH_PROMPT MS_REPL_TEST_SHORTCUTS MS_REPL_REPO_MAP
set -uo pipefail
cd "$(dirname "$0")/.."
umask 077
export REFACTORBENCH_DIR="${REFACTORBENCH_DIR:?Set REFACTORBENCH_DIR to the RefactorBench checkout}"
test "$(git -C "$REFACTORBENCH_DIR" rev-parse HEAD)" = 210b2d15a373ad265aa721f70199c9962d7de069 || exit 1
export EXERCISM_DIR=/tmp/polyglot-benchmark/python/exercises/practice  # Aider polyglot, clone of github.com/Aider-AI/polyglot-benchmark
test "$(git -C "$EXERCISM_DIR" rev-parse HEAD)" = 7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f || exit 1
export MS_FULL_TRACE=1
model=${MODEL:-anthropic/claude-haiku-5-5}
trials=${TRIALS:-3}
parallel=${TASKS_PARALLEL:-3}
out=$(mktemp -d benchmarks/artifacts/abc5.XXXXXX)
printf 'Artifacts: %s\n' "$out"
{ printf 'Model: %s\nTrials: %s\nms: %s\n' "$model" "$trials" "$(git rev-parse HEAD)"; sha256sum benchmarks/ab_single_tool.ts integrations/axiom/{ms-tool,python-repl}.ts; } > "$out/provenance.txt"
cp "$0" "$out/run.sh"

run() {
  local pack=$1 case_id=$2 label=$3 arm=$4 batch=$5 shortcuts=$6 map=${7:-0} dir="$out/$2/$3"
  mkdir -p "$dir"
  MS_REPL_BATCH_PROMPT=$batch MS_REPL_TEST_SHORTCUTS=$shortcuts MS_REPL_REPO_MAP=$map bun benchmarks/ab_single_tool.ts --pack "$pack" --cases "$case_id" \
    --trials "$trials" --max-steps 60 --lean --model "$model" --arms "$arm" --out "$dir" > "$dir/live.log" 2>&1
  jq -c --arg label "$label" '{variant:$label,caseId,trial,overallPassed,llmTurns,toolCalls,promptTokens,cacheWriteTokens,cachedTokens,completionTokens,normalizedTotalTokens,wallClockMs,probeOutput}' "$dir/runs.jsonl" > "$dir/metrics.jsonl"
}

task() {
  run "$1" "$2" B-repl B_repl 1 1 0 &
  run "$1" "$2" A-eight A_eight 0 1 0 &
  run "$1" "$2" B-one B_one 0 1 0 &
  # second arm: the iteration's change, e.g. run "$1" "$2" B-repl-new B_repl 1 1 0 &
  # holdout / every-3-kept runs add: A-eight A_eight 0 1 0, B-one B_one 0 1 0
  wait
  printf 'done: %s\n' "$2"
}

while read -r pack case_id; do
  while [ "$(jobs -rp | wc -l)" -ge "$parallel" ]; do wait -n; done
  task "$pack" "$case_id" &
  sleep 5  # staggered starts: simultaneous OAuth refreshes failed trial 0 in abc5.lLgLdX
done <<'CASES'
exercism book-store
exercism bowling
exercism dominoes
exercism forth
exercism go-counting
exercism grep
exercism pov
exercism react
exercism rest-api
exercism sgf-parsing
exercism two-bucket
exercism wordy
exercism zebra-puzzle
exercism zipper
exercism poker
CASES
# retired (won, iteration 6): refactorbench dev fastapi_refactor/value-is-a-sequence-test, celery_refactor/rename-host-format-test, scrapy_refactor/sitemap-url-to-url; holdout v2:
# refactorbench ansible_refactor/move-quoting-splitter-test
# refactorbench salt_refactor/iam-to-aws-test
# refactorbench django_refactor/safe-file-move
wait

fd -I -t f '^metrics\.jsonl$' "$out" -x cat {} > "$out/results.jsonl"
jq -s -r '
  group_by(.caseId + .variant)[]
  | (map(select(.overallPassed))) as $ok
  | [.[0].caseId[0:24], .[0].variant, "\($ok | length)/\(length)", (map(.llmTurns) | tostring),
     (if ($ok | length) > 0 then ($ok | map(.normalizedTotalTokens) | add / length | floor) else "-" end),
     (map(.wallClockMs) | add / length / 1000 | floor)]
  | @tsv' "$out/results.jsonl" | tee "$out/summary.tsv"
printf 'Artifacts: %s\n' "$out"
