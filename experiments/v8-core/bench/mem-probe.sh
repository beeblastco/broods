#!/usr/bin/env bash
# Where a warm worker's memory goes, per workerd.capnp mem* config. For each arm: one round of
# run-isolate.sh (one warm worker per agent, core's `cloudflare` sandbox provider on the local
# stand-in, scripted model, no docs search), then the router's memory with every worker warm and
# idle and after each worker collected its garbage (/__mem/gc); and once per arm the router's memory
# freshly started, before any worker loads. (warm-idle - fresh) / level is what one warm agent keeps.
# An arm <Config>:one runs every task on one agent, so one worker serves them all (the memory of
# sharing a worker, say per account). Rows go to <out.jsonl> (bench rows plus kind "mem").
# An arm <Config>@<ms> sets IDLE_UNLOAD_MS (memHolderConfig): the row "after-idle" is taken that
# long after the batch, and "after-unload" once every holder let go of its worker (/__mem/unload).
# The arm "bun" is today's core on Bun, restarted first, on the same stand-in. ROUNDS=n takes
# turns n times. Usage: [ROUNDS=n] mem-probe.sh <out.jsonl> <level> <arm>... with the stack up.
set -uo pipefail
OUT=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
level=$2
shift 2
cd "$(dirname "$0")/.."
source ./env.sh
L=$PWD/logs
mkdir -p "$L" results
[ -f "$L/worker-sandbox.key" ] || openssl rand -hex 32 > "$L/worker-sandbox.key"
export MAX_INPROCESS_WORKERS=64 BENCH_SCRIPTED_MODEL=1 BENCH_MODEL_DELAY_MS=${BENCH_MODEL_DELAY_MS:-0}
export AGENT_PER_TASK=1 WARMUP_EACH=1 NO_MCP=1 SHARED_FILES=1 SANDBOX=native SANDBOX_PROVIDER=cloudflare
export LOG_SUFFIX=-mem MEM_DEBUG=1
export CLOUDFLARE_SANDBOX_URL=http://127.0.0.1:8791
CLOUDFLARE_SANDBOX_API_KEY=$(cat "$L/worker-sandbox.key")
export CLOUDFLARE_SANDBOX_API_KEY

# The bench's Bun core takes the stack core's port.
for pid in $(lsof -ti "tcp:$((BENCH_PORT_BASE + 1))" -sTCP:LISTEN 2>/dev/null); do
  case "$(ps -o command= -p "$pid")" in
    *"src/server.ts"*) kill "$pid" ;;
    *) echo "port $((BENCH_PORT_BASE + 1)) is taken"; exit 1 ;;
  esac
done
SANDBOX_PORT=8791 bench/restart-cores.sh "$L" "$LOG_SUFFIX" || exit 1

router_pattern='^[^ ]*/workerd serve [^ ]*/v8-core/workerd\.capnp [a-zA-Z]+Config'
url=http://127.0.0.1:$((BENCH_PORT_BASE + 21))
rss() { bun -e "import { sample } from './bench/proc.ts'; console.log(sample(Number(process.argv[1])).rssMb.toFixed(1))" "$1"; }
row() { # <label> <stage> <pid>
  echo "{\"kind\":\"mem\",\"round\":$round,\"label\":\"$1\",\"stage\":\"$2\",\"rssMb\":$(rss "$3")}" >> "$OUT"
  tail -1 "$OUT"
}

for round in $(seq 1 "${ROUNDS:-1}"); do
for arm in "$@"; do
  if [ "$arm" = bun ]; then
    export AGENT_PER_TASK=1
    SANDBOX_PORT=8791 bench/restart-cores.sh "$L" "$LOG_SUFFIX" > /dev/null || exit 1
    pid=$(pgrep -f "[s]cripted-model-preload.ts src/server.ts")
    sleep 2
    row bun fresh $pid
    ARMS=bun:native bench/run-scripted.sh "$OUT" "$L" 1 "$level" "" || echo "FAILED bun"
    sleep 2
    row bun warm-idle $pid
    continue
  fi
  config=${arm%%[:@]*} label=$arm idle=0
  [[ $arm == *@* ]] && idle=${arm#*@}
  export IDLE_UNLOAD_MS=$idle
  if [ "$arm" = "$config:one" ]; then export AGENT_PER_TASK=0; else export AGENT_PER_TASK=1; fi
  # Freshly started: the router and the write queue, no worker loaded yet.
  pkill -f "$router_pattern"; while pgrep -f "$router_pattern" >/dev/null; do sleep 0.2; done
  nohup ./start-per-task.sh $((BENCH_PORT_BASE + 21)) mem-fresh "$config" >> "$L/isolate-core$LOG_SUFFIX.log" 2>&1 &
  fresh=$!
  for _ in $(seq 1 100); do (exec 3<>"/dev/tcp/127.0.0.1/$((BENCH_PORT_BASE + 21))") 2>/dev/null && break; sleep 0.2; done
  sleep 2
  row "$label" fresh $fresh
  kill $fresh; while kill -0 $fresh 2>/dev/null; do sleep 0.2; done

  PER_TASK_CONFIG=$config bench/run-isolate.sh "$OUT" "$L" 1 "$level" "-$(echo "$label" | tr ':@' '--')" || echo "FAILED $label"
  pid=$(pgrep -f "$router_pattern" | head -1)
  [ -n "$pid" ] || { echo "no router left for $label"; continue; }
  sleep 2
  row "$label" warm-idle $pid
  curl -s -m 60 -X POST "$url/__mem/gc" > /dev/null
  sleep 2
  row "$label" after-gc $pid
  if [ "$idle" != 0 ]; then
    sleep $(( idle / 1000 + 3 ))
    row "$label" after-idle $pid
  fi
  if [[ $config == memHolder* ]]; then
    curl -s -m 60 -X POST "$url/__mem/unload" > /dev/null
    sleep 3
    row "$label" after-unload $pid
  fi
done
done
pkill -f "$router_pattern"
pkill -f "[n]ative-sandbox.ts"
echo ALL-DONE
