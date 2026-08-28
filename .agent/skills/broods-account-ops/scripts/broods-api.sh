#!/usr/bin/env bash
# Call the broods gateway with the credential from env.
# usage: broods-api.sh METHOD PATH [JSON_BODY]
#   broods-api.sh GET /v1/agents
#   broods-api.sh POST /v1/crons '{"agentId":"...","schedule":"rate(1 day)","input":"..."}'
# env: BROODS_ACCOUNT_SECRET (or BROODS_API_KEY for runtime routes), BROODS_BASE_URL
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $(basename "$0") METHOD PATH [JSON_BODY]" >&2
  exit 2
fi

BASE_URL="${BROODS_BASE_URL:-https://gateway.broods.app}"
TOKEN="${BROODS_ACCOUNT_SECRET:-${BROODS_API_KEY:-}}"
if [ -z "$TOKEN" ]; then
  echo "error: set BROODS_ACCOUNT_SECRET (config plane) or BROODS_API_KEY (runtime)" >&2
  exit 1
fi

METHOD="$1"
REQUEST_PATH="$2"
BODY="${3:-}"

CURL_ARGS=(
  -sS
  --fail-with-body
  -X "$METHOD"
  -H "Authorization: Bearer $TOKEN"
  -H "Content-Type: application/json"
)
if [ -n "$BODY" ]; then
  CURL_ARGS+=(-d "$BODY")
fi

curl "${CURL_ARGS[@]}" "$BASE_URL$REQUEST_PATH"
echo
