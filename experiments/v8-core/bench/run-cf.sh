#!/usr/bin/env bash
# Today's core on Bun against the isolate setup (directEagerIdConfig), taking turns, both with core's
# `cloudflare` sandbox provider on a real bridge Worker, scripted model, no docs search.
#   warm: one sandbox per agent (SHARED_FILES=1), booted by a warm-up task, as a running conversation.
#   cold: a new sandbox for every task, so every task waits for a Container to start.
# Needs the local stack up in this checkout, and CLOUDFLARE_SANDBOX_URL (https) and
# CLOUDFLARE_SANDBOX_API_KEY in the environment; the key is never printed or written to a file.
# Usage: [OUT_PREFIX=cf] [CORE_FIX=1] run-cf.sh [rounds] [level] [arms]   (defaults: 3, 20, warm cold)
# Rows go to results/$OUT_PREFIX-<arm>.jsonl; the summary is printed at the end. CF_ARMS swaps the
# run-gap.sh arms, e.g. "bun:cf cfengines:2:directEagerSpokeConfig" for two engines and one writer.
set -uo pipefail
cd "$(dirname "$0")/.."
rounds=${1:-3} level=${2:-20} which=${3:-warm cold} prefix=${OUT_PREFIX:-cf}
: "${CLOUDFLARE_SANDBOX_URL:?export CLOUDFLARE_SANDBOX_URL, the bridge Worker}"
: "${CLOUDFLARE_SANDBOX_API_KEY:?export CLOUDFLARE_SANDBOX_API_KEY, the bridge key}"
export SANDBOX_PROVIDER=cloudflare NO_MCP=1 CLOUDFLARE_SANDBOX_URL CLOUDFLARE_SANDBOX_API_KEY
source ./env.sh
mkdir -p logs results

# The bridge answers a status call for an unused id with 200 when the key is right.
status=$(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_SANDBOX_API_KEY" |
  curl -s -m 20 -o /dev/null -w '%{http_code}' -K - "$CLOUDFLARE_SANDBOX_URL/v1/sandboxes/bench-preflight")
[ "$status" = 200 ] || { echo "bridge preflight: HTTP $status (want 200; 401 means the key does not match)"; exit 1; }

# Always rebuilt, so the isolates run this checkout's core and writer.
bun build.ts > /dev/null || exit 1
SLIM=1 bun build.ts ./entry.ts ./dist-slim > /dev/null || exit 1
# CORE_FIX=1: today's core queues each account's sandbox mirror writes in its own process
# (bench/core-account-mirror.patch, applied for this run only), the fair check against the writer.
if [ "${CORE_FIX:-0}" = 1 ]; then
  (cd ../.. && git apply experiments/v8-core/bench/core-account-mirror.patch) || exit 1
  trap '(cd ../.. && git apply -R experiments/v8-core/bench/core-account-mirror.patch)' EXIT
fi
# restart-cores.sh also starts the worker provider's settings; nothing listens there in this run.
[ -f logs/worker-sandbox.key ] || openssl rand -hex 32 > logs/worker-sandbox.key

# The bench's Bun core takes the stack core's port; any other listener on the bench ports is in the way.
for port in $((BENCH_PORT_BASE + 1)) $((BENCH_PORT_BASE + 11)) $(seq $((BENCH_PORT_BASE + 21)) $((BENCH_PORT_BASE + 29))); do
  for pid in $(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null); do
    cmd=$(ps -o command= -p "$pid")
    case "$cmd" in
      *"--watch src/server.ts"* | *"src/server.ts"* | *workerd.capnp*) kill "$pid" ;;
      *) echo "port $port is taken by: $cmd"; exit 1 ;;
    esac
  done
done

for arm in $which; do
  case $arm in
    warm) shared=1 ;;
    cold) shared=0 ;;
    *) echo "arm $arm: warm or cold"; exit 1 ;;
  esac
  echo "== $arm: $rounds rounds at $level tasks at once"
  SHARED_FILES=$shared GAP_ARMS=${CF_ARMS:-"bun:cf cf:directEagerIdConfig"} LOG_SUFFIX=-cf-$arm \
    bench/run-gap.sh "results/$prefix-$arm.jsonl" "$rounds" "$level"
done
python3 bench/gap-summary.py $(for arm in $which; do echo "results/$prefix-$arm.jsonl"; done)
echo "The stack's own core was stopped for the run: bun scripts/local-stack.ts up brings it back."
