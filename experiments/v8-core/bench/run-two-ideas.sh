#!/usr/bin/env bash
# The two ideas left after the database work, each against today and the fast
# setup: several workerd engines (ENGINES, one per core, agents placed on the
# engine with the fewest) and booking the agent's sandbox while the model
# thinks (core's reserveAhead). Booking is switched by which slim bundle the
# router loads: <nobook-dir> built from core without it, <book-dir> with it.
# Part 2 repeats the booking pair with a 1 s scripted model delay, so a booking
# made ahead has time to finish before the first command.
# Usage: run-two-ideas.sh <nobook-dir> <book-dir> [out.jsonl], with the local stack up.
set -uo pipefail
cd "$(dirname "$0")/.."
nobook=$1 book=$2
export MAX_INPROCESS_WORKERS=64 BENCH_SCRIPTED_MODEL=1 BENCH_MODEL_DELAY_MS=0 AGENT_PER_TASK=1 LOG_SUFFIX=-ideas WARMUP_EACH=1
L=$PWD/logs OUT=${3:-$PWD/results/two-ideas.jsonl}
container=$(docker ps --filter name=broods-convex --format '{{.Names}}' | head -1)
cg=/sys/fs/cgroup/cpuacct/docker/$(docker inspect -f '{{.Id}}' "$container")/cpuacct.usage
SANDBOX_PORT=8791 bench/restart-cores.sh $L -ideas || { echo "FAILED cores"; exit 1; }
arm() { # <label> <level> <command...>
  local label=$1 level=$2; shift 2
  local before=$(cat $cg)
  "$@" || echo "FAILED $label $level"
  local after=$(cat $cg)
  local tasks=$(grep '"kind":"audit"' $OUT | tail -1 | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['tasksStarted'])")
  echo "{\"kind\":\"convexCpu\",\"label\":\"$label\",\"level\":$level,\"ms\":$(( (after-before)/1000000 )),\"tasks\":$tasks,\"delayMs\":$BENCH_MODEL_DELAY_MS}" >> $OUT
}
bundle() { cp "$1/entry.js" dist-slim/entry.js; }
for round in 1 2; do
  for level in 1 10 20; do
    arm bun+machine $level env ARMS="bun:machine" bench/run-scripted.sh $OUT $L 1 $level ""
    bundle $nobook
    arm isolate+v8-fast $level env SANDBOX=native PER_TASK_CONFIG=slimFastConfig bench/run-isolate.sh $OUT $L 1 $level "-fast"
    arm isolate+v8-eng2 $level env SANDBOX=native ENGINES=2 FRONT_PLACE=least bench/run-isolate.sh $OUT $L 1 $level "-eng2"
    arm isolate+v8-eng3 $level env SANDBOX=native ENGINES=3 FRONT_PLACE=least bench/run-isolate.sh $OUT $L 1 $level "-eng3"
    bundle $book
    arm isolate+v8-book $level env SANDBOX=native PER_TASK_CONFIG=slimFastConfig bench/run-isolate.sh $OUT $L 1 $level "-book"
  done
done
export BENCH_MODEL_DELAY_MS=1000
for round in 1 2; do
  for level in 1 10 20; do
    bundle $nobook
    arm isolate+v8-fast-d1000 $level env SANDBOX=native PER_TASK_CONFIG=slimFastConfig bench/run-isolate.sh $OUT $L 1 $level "-fast-d1000"
    bundle $book
    arm isolate+v8-book-d1000 $level env SANDBOX=native PER_TASK_CONFIG=slimFastConfig bench/run-isolate.sh $OUT $L 1 $level "-book-d1000"
  done
done
bundle $nobook
pkill -f "^bun [^ ]*/bench/native-sandbox\.ts"
echo ALL-DONE
