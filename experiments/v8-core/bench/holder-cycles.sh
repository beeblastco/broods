#!/usr/bin/env bash
# Batches of new agents on one memHolderConfig-style router, with the router's memory once each batch
# has gone idle and again after one more request (a health check), so repeated batches show whether
# unloaded workers give their memory back. Usage: holder-cycles.sh <out.jsonl> <cycles> <level>
# [config] (default memHolderGcConfig), with the local stack up and the bench's Bun core running
# (bench/restart-cores.sh) for its log. With CLOUDFLARE_SANDBOX_URL and CLOUDFLARE_SANDBOX_API_KEY in
# the environment it uses that bridge; without, the local stand-in on 8791.
set -uo pipefail
OUT=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
cycles=$2 level=$3 config=${4:-memHolderGcConfig}
cd "$(dirname "$0")/.."
here=$PWD
source ./env.sh
L=$PWD/logs
export MAX_INPROCESS_WORKERS=64 BENCH_SCRIPTED_MODEL=1 BENCH_MODEL_DELAY_MS=0 MEM_DEBUG=1
export IDLE_UNLOAD_MS=${IDLE_UNLOAD_MS:-5000}
if [ -z "${CLOUDFLARE_SANDBOX_URL:-}" ]; then
  export CLOUDFLARE_SANDBOX_URL=http://127.0.0.1:8791
  CLOUDFLARE_SANDBOX_API_KEY=$(cat "$L/worker-sandbox.key")
  export CLOUDFLARE_SANDBOX_API_KEY CLOUDFLARE_WORKER_URL=$CLOUDFLARE_SANDBOX_URL CLOUDFLARE_WORKER_API_KEY=$CLOUDFLARE_SANDBOX_API_KEY
  rm -rf "$L/native-state"
  env -u BUN_OPTIONS nohup bun bench/native-sandbox.ts 8791 "$L/worker-sandbox.key" "$L/native-state" >> "$L/native-sandbox.log" 2>&1 &
fi
export CLOUDFLARE_SANDBOX_URL CLOUDFLARE_SANDBOX_API_KEY
port=$((BENCH_PORT_BASE + 21))
touch "$L/bun-core-mem.log"
nohup ./start-per-task.sh $port mem-cycles "$config" >> "$L/isolate-core-mem.log" 2>&1 &
router=$!
for _ in $(seq 1 100); do [ "$(curl -s -m 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/healthz")" = 200 ] && break; sleep 0.3; done
rss() { bun -e "import { sample } from '$here/bench/proc.ts'; console.log(sample(Number(process.argv[1])).rssMb.toFixed(1))" "$1"; }
row() { echo "{\"kind\":\"mem\",\"label\":\"$config@$IDLE_UNLOAD_MS\",\"stage\":\"$1\",\"rssMb\":$(rss $router)}" | tee -a "$OUT"; }
row start
for c in $(seq 1 "$cycles"); do
  (cd bench && env -u BUN_OPTIONS bun bench.ts --runtime isolate --sandbox v8 --mode scripted --levels "$level" \
    --reps 1 --warmup 1 --runtime-pid "$router" --runtime-log "$L/isolate-core-mem.log" \
    --other-log "$L/bun-core-mem.log" --label "isolate+holder-cycle$c" --out "$OUT" \
    --runtime-urls "http://127.0.0.1:$port" --agent-per-task --warmup-each --no-mcp --shared-files \
    --sandbox-provider cloudflare) | grep "level $level rep"
  sleep $(( IDLE_UNLOAD_MS / 1000 + 4 ))
  row "cycle$c-idle"
  curl -s -m 20 -o /dev/null "http://127.0.0.1:$port/healthz"
  sleep 3
  row "cycle$c-after-request"
done
kill $router
pkill -f "[n]ative-sandbox.ts" || true
