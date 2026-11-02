#!/usr/bin/env bash
# After the database work: today vs the fast setup, with the same-sandbox controls,
# and the database container's CPU per task for every arm and level.
# Usage: run-db-final.sh [out.jsonl], with the local stack up.
set -uo pipefail
cd "$(dirname "$0")/.."
export MAX_INPROCESS_WORKERS=64 BENCH_SCRIPTED_MODEL=1 BENCH_MODEL_DELAY_MS=0 AGENT_PER_TASK=1 LOG_SUFFIX=-dbfinal WARMUP_EACH=1
L=$PWD/logs OUT=${1:-$PWD/results/db-final.jsonl}
container=$(docker ps --filter name=broods-convex --format '{{.Names}}' | head -1)
cg=/sys/fs/cgroup/cpuacct/docker/$(docker inspect -f '{{.Id}}' "$container")/cpuacct.usage
SANDBOX_PORT=8791 bench/restart-cores.sh $L -dbfinal || { echo "FAILED cores"; exit 1; }
arm() { # <label> <level> <command...>
  local label=$1 level=$2; shift 2
  local before=$(cat $cg)
  "$@" || echo "FAILED $label $level"
  local after=$(cat $cg)
  local tasks=$(grep '"kind":"audit"' $OUT | tail -1 | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['tasksStarted'])")
  echo "{\"kind\":\"convexCpu\",\"label\":\"$label\",\"level\":$level,\"ms\":$(( (after-before)/1000000 )),\"tasks\":$tasks}" >> $OUT
}
for round in 1 2; do
  for level in 1 10 20; do
    arm bun+machine $level env ARMS="bun:machine" bench/run-scripted.sh $OUT $L 1 $level ""
    arm isolate+v8-fast $level env SANDBOX=native PER_TASK_CONFIG=slimFastConfig bench/run-isolate.sh $OUT $L 1 $level "-fast"
    arm bun+native $level env ARMS="bun:native" bench/run-scripted.sh $OUT $L 1 $level ""
    arm workerd+native $level env ARMS="workerd:native" bench/run-scripted.sh $OUT $L 1 $level ""
  done
done
pkill -f "[n]ative-sandbox.ts"
echo ALL-DONE
