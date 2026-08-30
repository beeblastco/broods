#!/usr/bin/env bash
# Call the broods gateway with the credential from the environment.
# usage: broods-api.sh METHOD PATH [JSON_BODY]
#   broods-api.sh GET /v1/agents
#   broods-api.sh POST /v1/crons '{"name":"nightly","agentId":"...","scheduleExpression":"rate(1 day)","input":"..."}'
# env: BROODS_SESSION_TOKEN or BROODS_ACCOUNT_SECRET (config plane),
#      BROODS_API_KEY (runtime routes), BROODS_BASE_URL
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $(basename "$0") METHOD PATH [JSON_BODY]" >&2
  exit 2
fi

TOKEN="${BROODS_SESSION_TOKEN:-${BROODS_ACCOUNT_SECRET:-${BROODS_API_KEY:-}}}"
if [ -z "$TOKEN" ]; then
  echo "error: set BROODS_SESSION_TOKEN, BROODS_ACCOUNT_SECRET, or BROODS_API_KEY" >&2
  exit 1
fi

CURL=(curl -sS --fail-with-body -X "$1"
  -H "Authorization: Bearer $TOKEN"
  -H "Content-Type: application/json")
if [ -n "${3:-}" ]; then CURL+=(-d "$3"); fi

"${CURL[@]}" "${BROODS_BASE_URL:-https://gateway.broods.app}$2"
echo
