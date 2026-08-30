#!/usr/bin/env bash
# Self-management API calls for a deployed broods agent.
# usage: self-api.sh METHOD PATH [JSON_BODY]
# env:
#   BROODS_BASE_URL          gateway url (default https://gateway.broods.app)
#   BROODS_SESSION_TOKEN     role session minted by the operator; used as is
#   BROODS_API_KEY           stage runtime key, exchanged with BROODS_ROLE_ID
#   BROODS_ROLE_ID           role to assume, pinned to this deployment's stage
#   BROODS_ROLE_TTL_SECONDS  session lifetime to request (default 3600, max 43200)
# Exchanged sessions are cached in a private file for their lifetime, so a run
# of many calls mints one session instead of one per call.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $(basename "$0") METHOD PATH [JSON_BODY]" >&2
  exit 2
fi

BASE_URL="${BROODS_BASE_URL:-https://gateway.broods.app}"
TOKEN="${BROODS_SESSION_TOKEN:-}"

if [ -z "$TOKEN" ]; then
  if [ -z "${BROODS_API_KEY:-}" ] || [ -z "${BROODS_ROLE_ID:-}" ]; then
    echo "error: set BROODS_SESSION_TOKEN, or BROODS_API_KEY + BROODS_ROLE_ID" >&2
    exit 1
  fi
  TTL="${BROODS_ROLE_TTL_SECONDS:-3600}"
  CACHE_DIR="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}"
  CACHE="$CACHE_DIR/.broods-session-$(printf '%s' "$BASE_URL/$BROODS_ROLE_ID" | cksum | cut -d' ' -f1)"
  NOW="$(date +%s)"

  if [ -r "$CACHE" ]; then
    read -r EXPIRES CACHED < "$CACHE" || true
    if [ -n "${CACHED:-}" ] && [ "$NOW" -lt "${EXPIRES:-0}" ]; then TOKEN="$CACHED"; fi
  fi

  if [ -z "$TOKEN" ]; then
    # Exchange the runtime key and role id for a short-lived session.
    RESPONSE="$(curl -sS --fail-with-body -X POST \
      -H "Authorization: Bearer $BROODS_API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"roleId\":\"$BROODS_ROLE_ID\",\"ttlSeconds\":$TTL}" \
      "$BASE_URL/v1/account/assume-role")"
    # sed, not jq: no sandbox image is guaranteed to ship jq.
    TOKEN="$(printf '%s' "$RESPONSE" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    if [ -z "$TOKEN" ]; then
      echo "error: assume-role returned no token: $RESPONSE" >&2
      exit 1
    fi
    (umask 077; printf '%s %s\n' "$((NOW + TTL - 60))" "$TOKEN" > "$CACHE")
  fi
fi

CURL=(curl -sS --fail-with-body -X "$1"
  -H "Authorization: Bearer $TOKEN"
  -H "Content-Type: application/json")
if [ -n "${3:-}" ]; then CURL+=(-d "$3"); fi

"${CURL[@]}" "$BASE_URL$2"
echo
