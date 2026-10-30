#!/usr/bin/env bash
# Serves apps/cloudflare-worker (the V8 bash sandbox) on local workerd through
# wrangler dev, with its R2 bucket on local disk. Usage: start-sandbox.sh <key-file> <state-dir> <log>
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo/apps/cloudflare-worker"
unset BUN_OPTIONS
bun run build >/dev/null
setsid node_modules/.bin/wrangler dev --port 8790 --ip 127.0.0.1 \
  --var "WORKER_API_KEY:$(cat "$1")" --persist-to "$2" > "$3" 2>&1 < /dev/null &
for _ in $(seq 1 100); do
  [ "$(curl -s -m 1 -o /dev/null -w '%{http_code}' http://127.0.0.1:8790/v1/sandboxes/x)" = "401" ] && { echo "sandbox worker ready"; exit 0; }
  sleep 0.3
done
echo "sandbox worker did not start"; tail -20 "$3"; exit 1
