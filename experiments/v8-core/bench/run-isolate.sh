#!/usr/bin/env bash
# Scripted bench of the "fresh V8 isolate per task" router (per-task/router.js
# on 4321). The router and the V8 sandbox are restarted before every level:
# workerd keeps each uniquely named loaded worker (about 110 MB apiece) and was
# not seen to evict any, so without a restart memory grows by the task count.
# PER_TASK_CONFIG=slimConfig runs the SLIM=1 bundle (dist-slim/) instead.
# Usage: [LOG_SUFFIX=-iso] [PER_TASK_CONFIG=...] run-isolate.sh <out.jsonl> <log-dir> <rounds> <levels> [label-suffix]
# Expects core on Bun (4301) up with BENCH_SCRIPTED_MODEL=1 logging to
# <log-dir>/bun-core$LOG_SUFFIX.log, and the bench env (BENCH_SCRIPTED_MODEL,
# BENCH_MODEL_DELAY_MS, MAX_INPROCESS_WORKERS) exported.
set -euo pipefail
out=$1 logs=$2 rounds=$3 levels=$4 suffix=${5:-} log_suffix=${LOG_SUFFIX:-}
config=${PER_TASK_CONFIG:-perTaskConfig}
here=$(cd "$(dirname "$0")" && pwd)
restart_sandbox() {
  local leader
  leader=$(pgrep -f "[w]rangler dev --port 8790" | head -1 || true)
  if [ -n "$leader" ]; then
    kill -- "-$(ps -o pgid= -p "$leader" | tr -d ' ')" 2>/dev/null || true
    while pgrep -f "[w]orkerd serve --binary" >/dev/null; do sleep 0.5; done
  fi
  "$here/../start-sandbox.sh" "$logs/worker-sandbox.key" "$logs/worker-state" "$logs/worker-sandbox.log"
  sandbox_pids=$(pgrep -f "[w]orkerd serve --binary" | paste -sd, -)
}
restart_router() {
  local old
  old=$(pgrep -f "[v]8-core/workerd.capnp (perTaskConfig|slimConfig)" || true)
  if [ -n "$old" ]; then
    kill $old
    while pgrep -f "[v]8-core/workerd.capnp (perTaskConfig|slimConfig)" >/dev/null; do sleep 0.2; done
  fi
  export CLOUDFLARE_WORKER_URL=http://127.0.0.1:8790
  CLOUDFLARE_WORKER_API_KEY=$(cat "$logs/worker-sandbox.key")
  export CLOUDFLARE_WORKER_API_KEY
  nohup "$here/../start-per-task.sh" 4321 bench-isolate "$config" >> "$logs/isolate-core$log_suffix.log" 2>&1 &
  for _ in $(seq 1 100); do
    [ "$(curl -s -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:4321/healthz)" = "200" ] && break
    sleep 0.3
  done
  router_pid=$(pgrep -f "[v]8-core/workerd.capnp $config")
}
# AGENT_PER_TASK=1 gives each task slot its own agent and sandbox files.
per_task=()
if [ "${AGENT_PER_TASK:-0}" = 1 ]; then per_task=(--agent-per-task); fi
cd "$here"
for round in $(seq 1 "$rounds"); do
  for level in ${levels//,/ }; do
    restart_sandbox
    restart_router
    echo "== round $round: isolate + v8, $level at once"
    env -u BUN_OPTIONS bun bench.ts --runtime isolate --sandbox v8 --mode scripted \
      --levels "$level" --reps 1 --warmup 1 --runtime-pid "$router_pid" --sandbox-pid "$sandbox_pids" \
      --runtime-log "$logs/isolate-core$log_suffix.log" --other-log "$logs/bun-core$log_suffix.log" \
      --label "isolate+v8$suffix" --out "$out" "${per_task[@]}"
  done
done
