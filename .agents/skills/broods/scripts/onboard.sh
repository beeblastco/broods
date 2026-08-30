#!/usr/bin/env bash
# Onboard this machine onto broods: check the CLI, check auth, and run the
# browser login when needed. Login is a human step, so run this where the
# user can see the browser open and finish it themselves.
# usage: onboard.sh
set -euo pipefail

if ! command -v broods > /dev/null 2>&1; then
  if command -v bun > /dev/null 2>&1; then
    echo "Installing the broods CLI with bun..."
    bun add -g broods
  elif command -v npm > /dev/null 2>&1; then
    echo "Installing the broods CLI with npm..."
    npm install -g broods
  else
    echo "error: neither bun nor npm found. Install bun (https://bun.sh) first." >&2
    exit 1
  fi
fi

WHOAMI="$(broods whoami 2>&1 || true)"
echo "$WHOAMI"

if printf '%s' "$WHOAMI" | grep -q "Not logged in"; then
  echo
  echo "Opening the browser to sign in. Finish the login there."
  broods login
  broods whoami
fi
