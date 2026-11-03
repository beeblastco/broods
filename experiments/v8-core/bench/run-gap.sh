#!/usr/bin/env bash
# Today (bun:machine) against the fast isolate setup, interleaved, with the whole box's CPU and the
# database container's CPU per arm, so a gap can be split into "Broods did more work" and "the box
# was busier". Usage: run-gap.sh <out.jsonl> <rounds> <level> [config], with the local stack up.
set -uo pipefail
# The arms run from bench/, so the rows file is pinned to an absolute path first.
OUT=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
cd "$(dirname "$0")/.."
export MAX_INPROCESS_WORKERS=64 BENCH_SCRIPTED_MODEL=1 BENCH_MODEL_DELAY_MS=${BENCH_MODEL_DELAY_MS:-0} AGENT_PER_TASK=${AGENT_PER_TASK:-1} LOG_SUFFIX=${LOG_SUFFIX:--gap} WARMUP_EACH=1
L=$PWD/logs rounds=$2 level=$3 config=${4:-slimFastConfig}
container=$(docker ps --filter name=broods-convex --format '{{.Names}}' | head -1)
# The database container's CPU (cgroup v1) and the whole box's, where Linux shows them; elsewhere
# (macOS runs Docker in a VM) those columns read 0 and only the bench's own rows count.
cg=/sys/fs/cgroup/cpuacct/docker/$(docker inspect -f '{{.Id}}' "$container")/cpuacct.usage
convex_ns() { cat "$cg" 2>/dev/null || echo 0; }
busy() { awk '/^cpu /{print $2+$3+$4+$7+$8+$9, $2+$3+$4+$5+$6+$7+$8+$9}' /proc/stat 2>/dev/null || echo "0 0"; }
SANDBOX_PORT=8791 bench/restart-cores.sh $L $LOG_SUFFIX || { echo "FAILED cores"; exit 1; }
arm() { # <label> <command...>
  local label=$1; shift
  local c0=$(convex_ns) b0
  read -r b0 t0 < <(busy)
  "$@" || echo "FAILED $label"
  local c1=$(convex_ns) b1
  read -r b1 t1 < <(busy)
  local tasks=$(grep '"kind":"audit"' $OUT | tail -1 | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['tasksStarted'])")
  echo "{\"kind\":\"box\",\"label\":\"$label\",\"level\":$level,\"convexMs\":$(( (c1-c0)/1000000 )),\"tasks\":$tasks,\"boxBusyPct\":$(python3 -c "print(round(100*($b1-$b0)/($t1-$t0),1) if $t1>$t0 else 0)")}" >> $OUT
  tail -1 $OUT
}
# GAP_ARMS: any of bun:machine, bun:native (today's core on the isolate's sandbox), fast, and direct
# (fast with only the usage and budget writes through the write queue). NO_MCP=1 drops the docs search,
# NO_SANDBOX=1 the sandbox too, and AGENT_PER_TASK=0 runs every task on one agent (one isolate).
# cfg:<Name> runs the isolate router with workerd.capnp's config <Name>; engines:<n>:<Name> runs n of them.
# bun:cf and cf:<Name> start no sandbox: with SANDBOX_PROVIDER=cloudflare both reach the bridge Worker
# at CLOUDFLARE_SANDBOX_URL (bench/run-cf.sh). SHARED_FILES=1 keeps one sandbox per agent.
for round in $(seq 1 $rounds); do
  for a in ${GAP_ARMS:-bun:machine bun:native fast}; do
    if [ $a = fast ]; then
      arm isolate+v8-fast env SANDBOX=native PER_TASK_CONFIG=$config bench/run-isolate.sh $OUT $L 1 $level "-fast"
    elif [ $a = direct ]; then
      arm isolate+v8-direct env SANDBOX=native PER_TASK_CONFIG=slimDirectConfig bench/run-isolate.sh $OUT $L 1 $level "-direct"
    elif [ "${a%%:*}" = engines ]; then
      # engines:<n>:<Config>, n workerd processes with that config.
      local_n=${a#engines:}; local_n=${local_n%%:*}
      arm isolate+v8-${local_n}x${a##*:} env SANDBOX=native ENGINES=$local_n PER_TASK_CONFIG=${a##*:} bench/run-isolate.sh $OUT $L 1 $level "-${local_n}x${a##*:}"
    elif [ "${a%%:*}" = cf ]; then
      arm isolate+cf-${a#cf:} env SANDBOX=none PER_TASK_CONFIG=${a#cf:} bench/run-isolate.sh $OUT $L 1 $level "-${a#cf:}"
    elif [ "${a%%:*}" = cfg ]; then
      arm isolate+v8-${a#cfg:} env SANDBOX=native PER_TASK_CONFIG=${a#cfg:} bench/run-isolate.sh $OUT $L 1 $level "-${a#cfg:}"
    else
      arm ${a/:/+} env ARMS="$a" bench/run-scripted.sh $OUT $L 1 $level ""
    fi
  done
done
pkill -f "[n]ative-sandbox.ts"
echo ALL-DONE
