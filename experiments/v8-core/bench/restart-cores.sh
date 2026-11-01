#!/usr/bin/env bash
# Restarts core on Bun (4301) and core on workerd (4311) with the bench env the
# caller exports (BENCH_SCRIPTED_MODEL, BENCH_MODEL_DELAY_MS,
# MAX_INPROCESS_WORKERS), waiting for the old processes to exit and the new
# ones to answer /healthz. Usage: restart-cores.sh <log-dir> [log-suffix]
set -euo pipefail
logs=$1 suffix=${2:-}
here=$(cd "$(dirname "$0")/.." && pwd)
old=$(pgrep -f "[a]pps/core.*src/server.ts|^bun (--preload \S+ )?src/server.ts|[v]8-core/workerd.capnp config" || true)
if [ -n "$old" ]; then
  kill $old
  while pgrep -f "^bun (--preload \S+ )?src/server.ts|[v]8-core/workerd.capnp config" >/dev/null; do sleep 0.2; done
fi
# SANDBOX_PORT=8791 points both cores at bench/native-sandbox.ts instead of the V8 sandbox.
export CLOUDFLARE_WORKER_URL=http://127.0.0.1:${SANDBOX_PORT:-8790}
CLOUDFLARE_WORKER_API_KEY=$(cat "$logs/worker-sandbox.key")
export CLOUDFLARE_WORKER_API_KEY
nohup "$here/start-bun.sh" 4301 bench-bun > "$logs/bun-core$suffix.log" 2>&1 &
nohup "$here/start.sh" 4311 bench-workerd > "$logs/workerd-core$suffix.log" 2>&1 &
for port in 4301 4311; do
  for _ in $(seq 1 100); do
    [ "$(curl -s -m 1 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/healthz")" = "200" ] && break
    sleep 0.2
  done
  [ "$(curl -s -m 1 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/healthz")" = "200" ] || { echo "core on $port did not start"; exit 1; }
done
echo "cores up: bun $(pgrep -f '^bun (--preload \S+ )?src/server.ts') workerd $(pgrep -f '[v]8-core/workerd.capnp config')"
