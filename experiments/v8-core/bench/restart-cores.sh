#!/usr/bin/env bash
# Restarts core on Bun (BENCH_PORT_BASE+1) and core on workerd (+11) with the bench env the
# caller exports (BENCH_SCRIPTED_MODEL, BENCH_MODEL_DELAY_MS, MAX_INPROCESS_WORKERS), waiting for
# the old processes to exit and the new ones to answer /healthz. BENCH_PORT_BASE defaults to the
# local stack's port block, so the Bun core takes the place of the stack's own core (stop that one
# first). Usage: restart-cores.sh <log-dir> [log-suffix]
set -euo pipefail
logs=$1 suffix=${2:-}
here=$(cd "$(dirname "$0")/.." && pwd)
source "$here/env.sh"
bun_port=$((BENCH_PORT_BASE + 1)) workerd_port=$((BENCH_PORT_BASE + 11))
pattern="^bun (--preload [^ ]+ )?src/server.ts|[v]8-core/workerd.capnp config"
old=$(pgrep -f "$pattern" || true)
if [ -n "$old" ]; then
  kill $old
  while pgrep -f "$pattern" >/dev/null; do sleep 0.2; done
fi
# SANDBOX_PORT=8791 points both cores at bench/native-sandbox.ts instead of the V8 sandbox.
export CLOUDFLARE_WORKER_URL=http://127.0.0.1:${SANDBOX_PORT:-8790}
CLOUDFLARE_WORKER_API_KEY=$(cat "$logs/worker-sandbox.key")
export CLOUDFLARE_WORKER_API_KEY
nohup "$here/start-bun.sh" $bun_port bench-bun > "$logs/bun-core$suffix.log" 2>&1 &
nohup "$here/start.sh" $workerd_port bench-workerd > "$logs/workerd-core$suffix.log" 2>&1 &
for port in $bun_port $workerd_port; do
  for _ in $(seq 1 100); do
    [ "$(curl -s -m 1 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/healthz")" = "200" ] && break
    sleep 0.2
  done
  [ "$(curl -s -m 1 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/healthz")" = "200" ] || { echo "core on $port did not start"; exit 1; }
done
echo "cores up: bun $(pgrep -f '^bun (--preload [^ ]+ )?src/server.ts') workerd $(pgrep -f '[v]8-core/workerd.capnp config')"
