#!/usr/bin/env bash
# Round-robin scripted bench: every round runs each arm once, so drift in the
# shared pieces (the public MCP server, the machine) spreads over all arms.
# The V8 sandbox is restarted before each arm that uses it, so every arm starts
# from the same empty sandbox memory (local wrangler dev keeps every loaded
# isolate and was seen to crash near 4.6 GB).
# Usage: [ARMS="workerd:v8"] [LOG_SUFFIX=-iso] run-scripted.sh <out.jsonl> <log-dir> <rounds> <levels> [label-suffix]
# Expects core on Bun (4301) and core on workerd (4311) already up with
# BENCH_SCRIPTED_MODEL=1, logging to <log-dir>/{bun,workerd}-core$LOG_SUFFIX.log, and the
# sandbox key in <log-dir>/worker-sandbox.key. A "native" arm restarts
# bench/native-sandbox.ts on 8791 first; start the cores with SANDBOX_PORT=8791
# (restart-cores.sh) so core's worker provider reaches it.
set -euo pipefail
out=$1 logs=$2 rounds=$3 levels=$4 suffix=${5:-} log_suffix=${LOG_SUFFIX:-}
bun_pid=$(pgrep -f "[s]cripted-model-preload.ts src/server.ts")
workerd_pid=$(pgrep -f "[v]8-core/workerd.capnp config")
here=$(cd "$(dirname "$0")" && pwd)
restart_sandbox() {
  local leader
  leader=$(pgrep -f "[w]rangler dev --port 8790" | head -1 || true)
  if [ -n "$leader" ]; then
    kill -- "-$(ps -o pgid= -p "$leader" | tr -d ' ')" 2>/dev/null || true
    while pgrep -f "[w]orkerd serve --binary" >/dev/null; do sleep 0.5; done
  fi
  "$here/../start-sandbox.sh" "$logs/worker-sandbox.key" "$logs/worker-state" "$logs/worker-sandbox.log"
  # wrangler dev runs the V8 sandbox in two workerd processes.
  sandbox_pids=$(pgrep -f "[w]orkerd serve --binary" | paste -sd, -)
}
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
# AGENT_PER_TASK=1 gives each task slot its own agent and sandbox files.
per_task=()
if [ "${AGENT_PER_TASK:-0}" = 1 ]; then per_task=(--agent-per-task); fi
if [ "${WARMUP_EACH:-0}" = 1 ]; then per_task+=(--warmup-each); fi
cd "$here"
for round in $(seq 1 "$rounds"); do
  for arm in ${ARMS:-bun:machine workerd:v8 bun:v8}; do
    set -- ${arm/:/ }
    runtime=$1 sandbox=$2
    pid=$bun_pid other=workerd
    if [ "$runtime" = workerd ]; then pid=$workerd_pid other=bun; fi
    extra=() kind=$sandbox
    if [ "$sandbox" = v8 ]; then restart_sandbox; extra=(--sandbox-pid "$sandbox_pids"); fi
    if [ "$sandbox" = native ]; then restart_native; extra=(--sandbox-pid "$sandbox_pids") kind=v8; fi
    echo "== round $round: $runtime + $sandbox"
    env -u BUN_OPTIONS bun bench.ts --runtime "$runtime" --sandbox "$kind" --mode scripted \
      --levels "$levels" --reps 1 --warmup 1 --runtime-pid "$pid" "${extra[@]}" \
      --runtime-log "$logs/$runtime-core$log_suffix.log" --other-log "$logs/$other-core$log_suffix.log" \
      --label "$runtime+$sandbox$suffix" --out "$out" "${per_task[@]}"
  done
done
