#!/usr/bin/env bash
# Core's real code on self-hosted workerd. Usage: start.sh <port> <service-name>
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/env.sh"
export SERVICE_NAME=$2
workerd=$(find "$here/../../node_modules/.bun" -path "*workerd-linux-64@1.20261019.1*" -name workerd -type f | head -1)
exec "$workerd" serve "$here/workerd.capnp" config --experimental --socket-addr "http=127.0.0.1:$1"
