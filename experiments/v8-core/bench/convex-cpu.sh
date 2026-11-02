#!/usr/bin/env bash
# Convex CPU (container cpuacct) per task for one arm at one level, plus the
# latency of every Convex call in that run (written to <out.jsonl>.lat).
# Usage: convex-cpu.sh <fast|bun:machine|bun:native|workerd:native> <level> <out.jsonl> [label]
# with the cores started by restart-cores.sh (SANDBOX_PORT=8791, log suffix -db).
set -uo pipefail
cd "$(dirname "$0")/.."
export MAX_INPROCESS_WORKERS=64 BENCH_SCRIPTED_MODEL=1 BENCH_MODEL_DELAY_MS=0 AGENT_PER_TASK=1 LOG_SUFFIX=-db WARMUP_EACH=1
L=$PWD/logs arm=$1 level=$2 out=$3 label=${4:-}
# The local stack's Convex container; its CPU comes from cgroup v1 cpuacct.
container=$(docker ps --filter name=broods-convex --format '{{.Names}}' | head -1)
cg=/sys/fs/cgroup/cpuacct/docker/$(docker inspect -f '{{.Id}}' "$container")/cpuacct.usage
case $arm in fast) log=$L/isolate-core-db.log ;; bun:*) log=$L/bun-core-db.log ;; *) log=$L/workerd-core-db.log ;; esac
start=$(wc -l < $log 2>/dev/null || echo 0)
before=$(cat $cg)
if [ $arm = fast ]; then
  SANDBOX=native PER_TASK_CONFIG=${CONFIG:-slimFastConfig} bench/run-isolate.sh $out $L 1 $level "-fast$label" 2>&1 | grep -E "level|audit" | cut -c1-230
else
  ARMS=$arm bench/run-scripted.sh $out $L 1 $level "$label" 2>&1 | grep -E "level|audit" | cut -c1-230
fi
after=$(cat $cg)
tail -n +$((start+1)) $log | grep -o "BENCH_CONVEX .*" > $out.lat
tasks=$(tail -1 $out | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['tasksStarted'])")
echo "$arm L$level convex cpu $(( (after-before)/1000000 )) ms total, $(( (after-before)/1000000/tasks )) ms/task over $tasks tasks"
awk -v t=$tasks '{n[$2]++; s[$2]+=$3; c++; a+=$3} END {for (k in n) printf "  %-42s %6.1f/task %6.0f ms avg\n", k, n[k]/t, s[k]/n[k]; printf "  ALL %.1f calls/task, %.0f ms call time/task\n", c/t, a/t}' $out.lat | sort -k2 -nr | head -14
