#!/usr/bin/env bash
# Scripted bench of the "fresh V8 isolate per task" router (per-task/router.js
# on 4321). The router and the V8 sandbox are restarted before every level:
# workerd keeps each uniquely named loaded worker (about 110 MB apiece) and was
# not seen to evict any, so without a restart memory grows by the task count.
# PER_TASK_CONFIG=slimConfig runs the SLIM=1 bundle (dist-slim/) instead;
# slimWarmConfig keeps one loaded worker per agent, and slimFastConfig adds
# one shared queue for their Convex writes. SANDBOX=native swaps the
# V8 sandbox for bench/native-sandbox.ts (real bash, same HTTP API) on 8791.
# REPS=n measures n batches per level on one router (default 1).
# ENGINES=n runs n workerd engines (slimEngineConfig, ports 4371..) behind
# bench/engine-front.ts on 4321, with one writer process (writerConfig, 4369)
# for their queued usage writes; core CPU and memory are summed over all of them.
# Usage: [LOG_SUFFIX=-iso] [PER_TASK_CONFIG=...] run-isolate.sh <out.jsonl> <log-dir> <rounds> <levels> [label-suffix]
# Expects core on Bun (4301) up with BENCH_SCRIPTED_MODEL=1 logging to
# <log-dir>/bun-core$LOG_SUFFIX.log, and the bench env (BENCH_SCRIPTED_MODEL,
# BENCH_MODEL_DELAY_MS, MAX_INPROCESS_WORKERS) exported.
set -euo pipefail
out=$1 logs=$2 rounds=$3 levels=$4 suffix=${5:-} log_suffix=${LOG_SUFFIX:-}
config=${PER_TASK_CONFIG:-perTaskConfig}
here=$(cd "$(dirname "$0")" && pwd)
restart_sandbox() {
  if [ "${SANDBOX:-v8}" = native ]; then
    local old
    old=$(pgrep -f "[n]ative-sandbox.ts" || true)
    if [ -n "$old" ]; then kill $old; while pgrep -f "[n]ative-sandbox.ts" >/dev/null; do sleep 0.2; done; fi
    rm -rf "$logs/native-state"
    env -u BUN_OPTIONS nohup bun "$here/native-sandbox.ts" 8791 "$logs/worker-sandbox.key" "$logs/native-state" >> "$logs/native-sandbox.log" 2>&1 &
    for _ in $(seq 1 50); do
      [ "$(curl -s -m 1 -o /dev/null -w '%{http_code}' http://127.0.0.1:8791/v1/sandboxes/x)" = "401" ] && break
      sleep 0.2
    done
    sandbox_pids=$(pgrep -f "[n]ative-sandbox.ts" | paste -sd, -)
    return
  fi
  local leader
  leader=$(pgrep -f "[w]rangler dev --port 8790" | head -1 || true)
  if [ -n "$leader" ]; then
    kill -- "-$(ps -o pgid= -p "$leader" | tr -d ' ')" 2>/dev/null || true
    while pgrep -f "[w]orkerd serve --binary" >/dev/null; do sleep 0.5; done
  fi
  "$here/../start-sandbox.sh" "$logs/worker-sandbox.key" "$logs/worker-state" "$logs/worker-sandbox.log"
  sandbox_pids=$(pgrep -f "[w]orkerd serve --binary" | paste -sd, -)
}
# Anchored to the program, so no shell whose command line names them matches.
router_pattern='^[^ ]*/workerd serve [^ ]*/v8-core/workerd\.capnp [a-zA-Z]+Config|^bun [^ ]*/bench/engine-front\.ts'
restart_router() {
  local old
  old=$(pgrep -f "$router_pattern" || true)
  if [ -n "$old" ]; then
    kill $old
    while pgrep -f "$router_pattern" >/dev/null; do sleep 0.2; done
  fi
  export CLOUDFLARE_WORKER_URL=http://127.0.0.1:8790
  if [ "${SANDBOX:-v8}" = native ]; then CLOUDFLARE_WORKER_URL=http://127.0.0.1:8791; fi
  CLOUDFLARE_WORKER_API_KEY=$(cat "$logs/worker-sandbox.key")
  export CLOUDFLARE_WORKER_API_KEY
  # start-per-task.sh execs workerd, so each $! is the process itself.
  local pids=()
  if [ -n "${ENGINES:-}" ]; then
    local ports=() i
    nohup "$here/../start-per-task.sh" 4369 bench-writer writerConfig >> "$logs/isolate-core$log_suffix.log" 2>&1 &
    pids+=($!)
    for i in $(seq 1 "$ENGINES"); do
      ports+=($((4370 + i)))
      nohup "$here/../start-per-task.sh" $((4370 + i)) bench-isolate slimEngineConfig >> "$logs/isolate-core$log_suffix.log" 2>&1 &
      pids+=($!)
    done
    env -u BUN_OPTIONS nohup bun "$here/engine-front.ts" 4321 "${ports[@]}" >> "$logs/engine-front.log" 2>&1 &
    pids+=($!)
  else
    nohup "$here/../start-per-task.sh" 4321 bench-isolate "$config" >> "$logs/isolate-core$log_suffix.log" 2>&1 &
    pids+=($!)
  fi
  for _ in $(seq 1 100); do
    [ "$(curl -s -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:4321/healthz)" = "200" ] && break
    sleep 0.3
  done
  router_pid=$(IFS=,; echo "${pids[*]}")
}
# AGENT_PER_TASK=1 gives each task slot its own agent and sandbox files.
per_task=()
if [ "${AGENT_PER_TASK:-0}" = 1 ]; then per_task=(--agent-per-task); fi
# WARMUP_EACH=1 runs one task per agent before measuring, so a router that
# keeps workers per agent (slimWarmConfig) is measured warm.
if [ "${WARMUP_EACH:-0}" = 1 ]; then per_task+=(--warmup-each); fi
cd "$here"
for round in $(seq 1 "$rounds"); do
  for level in ${levels//,/ }; do
    restart_sandbox
    restart_router
    echo "== round $round: isolate + v8, $level at once"
    env -u BUN_OPTIONS bun bench.ts --runtime isolate --sandbox v8 --mode scripted \
      --levels "$level" --reps "${REPS:-1}" --warmup 1 --runtime-pid "$router_pid" --sandbox-pid "$sandbox_pids" \
      --runtime-log "$logs/isolate-core$log_suffix.log" --other-log "$logs/bun-core$log_suffix.log" \
      --label "isolate+v8$suffix" --out "$out" "${per_task[@]}"
  done
done
