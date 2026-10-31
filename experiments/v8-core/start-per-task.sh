#!/usr/bin/env bash
# Core with a fresh V8 isolate per request (per-task/router.js) on workerd.
# Usage: start-per-task.sh <port> <service-name> [config] (perTaskConfig, or
# slimConfig for the SLIM=1 bundle in dist-slim/)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/env.sh"
export SERVICE_NAME=$2
workerd=$(find "$here/../../node_modules/.bun" -path "*workerd-linux-64@1.20261019.1*" -name workerd -type f | head -1)
exec "$workerd" serve "$here/workerd.capnp" "${3:-perTaskConfig}" --experimental --socket-addr "http=127.0.0.1:$1"
