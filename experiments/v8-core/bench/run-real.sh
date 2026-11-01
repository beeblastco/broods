#!/usr/bin/env bash
# Real-model bench (Haiku 5.5, high effort): each round runs each arm once at
# every level, so the model provider's drift spreads over all arms. The V8
# sandbox is restarted before each arm that uses it, and the per-task router
# before each isolate arm (it keeps every loaded isolate).
# Usage: ANTHROPIC_API_KEY=... [ARMS=...] [AGENT_PER_TASK=1] run-real.sh <out.jsonl> <log-dir> <rounds> <levels>
# Expects core on Bun (4301) and on workerd (4311) up WITHOUT the scripted
# model, logging to <log-dir>/{bun,workerd}-core-real.log; the per-task router
# logs to <log-dir>/isolate-core-real.log.
set -euo pipefail
out=$1 logs=$2 rounds=$3 levels=$4
# PER_TASK_CONFIG=slimConfig runs the isolate arm on the SLIM=1 bundle (dist-slim/);
# slimWarmConfig keeps one loaded worker per agent, and slimFastConfig adds one
# shared queue for their Convex writes. An arm "isolate:native"
# uses bench/native-sandbox.ts (real bash, same HTTP API) on 8791.
config=${PER_TASK_CONFIG:-perTaskConfig}
: "${ANTHROPIC_API_KEY:?set ANTHROPIC_API_KEY}"
bun_pid=$(pgrep -f "^bun src/server.ts" | head -1)
workerd_pid=$(pgrep -f "[v]8-core/workerd.capnp config")
here=$(cd "$(dirname "$0")" && pwd)
restart_native() {
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
}
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
  old=$(pgrep -f "[v]8-core/workerd.capnp [a-zA-Z]+Config" || true)
  if [ -n "$old" ]; then
    kill $old
    while pgrep -f "[v]8-core/workerd.capnp [a-zA-Z]+Config" >/dev/null; do sleep 0.2; done
  fi
  CLOUDFLARE_WORKER_URL=http://127.0.0.1:$sandbox_port CLOUDFLARE_WORKER_API_KEY=$(cat "$logs/worker-sandbox.key") \
    BENCH_SCRIPTED_MODEL=0 BENCH_MODEL_DELAY_MS=0 \
    nohup "$here/../start-per-task.sh" 4321 bench-isolate "$config" >> "$logs/isolate-core-real.log" 2>&1 &
  for _ in $(seq 1 100); do
    [ "$(curl -s -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:4321/healthz)" = "200" ] && break
    sleep 0.3
  done
  isolate_pid=$(pgrep -f "[v]8-core/workerd.capnp $config")
}
# AGENT_PER_TASK=1 gives each task slot its own agent and sandbox files;
# SHARED_FILES=1 lets a parent and its subagent share their V8 sandbox files.
per_task=()
if [ "${AGENT_PER_TASK:-0}" = 1 ]; then per_task=(--agent-per-task); fi
if [ "${SHARED_FILES:-0}" = 1 ]; then per_task+=(--shared-files); fi
if [ "${WARMUP_EACH:-0}" = 1 ]; then per_task+=(--warmup-each); fi
cd "$here"
for round in $(seq 1 "$rounds"); do
  for arm in ${ARMS:-bun:machine workerd:v8 bun:v8 isolate:v8}; do
    set -- ${arm/:/ }
    runtime=$1 sandbox=$2
    extra=() sandbox_port=8790 kind=$sandbox
    if [ "$sandbox" = v8 ]; then restart_sandbox; extra=(--sandbox-pid "$sandbox_pids"); fi
    if [ "$sandbox" = native ]; then restart_native; sandbox_port=8791 kind=v8; extra=(--sandbox-pid "$sandbox_pids"); fi
    case $runtime in
      bun) pid=$bun_pid other=workerd ;;
      workerd) pid=$workerd_pid other=bun ;;
      isolate) restart_router; pid=$isolate_pid other=bun ;;
    esac
    echo "== round $round: $runtime + $sandbox"
    env -u BUN_OPTIONS bun bench.ts --runtime "$runtime" --sandbox "$kind" --mode real \
      --levels "$levels" --reps 1 --warmup 0 --runtime-pid "$pid" "${extra[@]}" \
      --runtime-log "$logs/$runtime-core-real.log" --other-log "$logs/$other-core-real.log" \
      --label "$runtime+$sandbox/haiku${LABEL_SUFFIX:-}" --out "$out" "${per_task[@]}" || echo "arm failed: $runtime + $sandbox"
  done
done
