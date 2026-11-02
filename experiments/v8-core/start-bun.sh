#!/usr/bin/env bash
# Core on Bun, as production runs it (no --watch), with the same env as
# start.sh. BENCH_SCRIPTED_MODEL=1 preloads the scripted model.
# Usage: start-bun.sh <port> <service-name>
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/env.sh"
export SERVICE_NAME=$2 PORT=$1
cd "$here/../../apps/core"
if [ "$BENCH_SCRIPTED_MODEL" = "1" ]; then
  exec bun --preload "$here/scripted-model-preload.ts" src/server.ts
fi
exec bun src/server.ts
