#!/usr/bin/env bash
# Self-management API calls for a deployed broods agent.
# usage: self-api.sh METHOD PATH [JSON_BODY]
# env:
#   BROODS_BASE_URL         gateway url (default https://gateway.broods.app)
#   BROODS_SELF_TOKEN       pre-scoped credential injected by the operator (interim path)
#   BROODS_API_KEY          stage runtime key, used with BROODS_ACCOUNT_ROLE_ID once
#   BROODS_ACCOUNT_ROLE_ID  role to assume for the session
# Session tokens are cached in this process's env only, never written to disk.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $(basename "$0") METHOD PATH [JSON_BODY]" >&2
  exit 2
fi

BASE_URL="${BROODS_BASE_URL:-https://gateway.broods.app}"
METHOD="$1"
REQUEST_PATH="$2"
BODY="${3:-}"

resolve_token() {
  if [ -n "${BROODS_SELF_TOKEN:-}" ]; then
    printf '%s' "$BROODS_SELF_TOKEN"

    return
  fi
  if [ -z "${BROODS_API_KEY:-}" ] || [ -z "${BROODS_ACCOUNT_ROLE_ID:-}" ]; then
    echo "error: set BROODS_SELF_TOKEN, or BROODS_API_KEY + BROODS_ACCOUNT_ROLE_ID" >&2
    exit 1
  fi
  # Exchange the runtime key + role id for a short-lived session (phase 1 endpoint).
  RESPONSE="$(curl -sS --fail-with-body -X POST \
    -H "Authorization: Bearer $BROODS_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"roleId\":\"$BROODS_ACCOUNT_ROLE_ID\"}" \
    "$BASE_URL/v1/account/assume-role")"
  TOKEN="$(printf '%s' "$RESPONSE" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  if [ -z "$TOKEN" ]; then
    echo "error: assume-role returned no token: $RESPONSE" >&2
    exit 1
  fi
  printf '%s' "$TOKEN"
}

TOKEN="$(resolve_token)"

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
