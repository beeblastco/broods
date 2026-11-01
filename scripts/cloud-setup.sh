#!/usr/bin/env bash
# Writes what a Claude Code cloud environment for this repo needs into
# ~/.broods-cloud/ (outside the checkout, mode 0600):
#   setup.sh             -> environment dialog, "Setup script" (Choose file)
#   env.txt              -> "Environment variables" (paste whole file)
# No network secrets: the proxy sets its Authorization header on every request
# to a broods gateway, runtime-key calls included, which then answer 401. The
# probe's tokens sit in env.txt instead; they reach only the probe's org.
# Versions are read from the checkout: rerun and re-upload setup.sh after a bump
# of .bun-version, Playwright, the Lean toolchain or the local-stack images.
#
# Cloud sessions act as the one probe user (CI's DASHBOARD_E2E_EMAIL), never you: each session
# makes its own project (`$BROODS_CLOUD_PROJECT`, set by cloud-session-start.sh)
# in that account's org on dev and deletes it when done. Prod stays read-only.
# The account is a WorkOS user made by hand in BOTH WorkOS environments (Staging
# serves dev, Production serves prod), same email and password, email verified,
# allowed under Radar > Restrictions in both (else AuthKit shows the cloud VM a
# bot check). Hobby's 9 sandbox hours a month are shared by CI and every
# session; once spent, runs stop until the month resets.
# --login signs that account in to dev and prod. The CLI prints a URL; open it
# in a private window and sign in as the test user.
# Its logins live in ~/.broods-cloud/test-account, apart from your own
# ~/.broods, and last 90 days: rerun --login and re-paste env.txt after that.
# A login for any other user is ignored, so a person's token never ships.
#
# Values, first found wins:
#   BROODS_DEV_TOKEN, BROODS_PROD_TOKEN  env, else the probe's login in test-account
#   E2E_EMAIL, E2E_PASSWORD  env, else apps/dashboard/.env.local (main checkout's from a worktree)
#   ANTHROPIC_API_KEY, OPENAI_API_KEY  env only (separate keys with a spend limit)
# The Anthropic key ships as CLOUD_ANTHROPIC_API_KEY: a cloud session drops an
# ANTHROPIC_API_KEY from the environment, and the session hook maps it back.
#
# Usage: bash scripts/cloud-setup.sh [--login]
set -euo pipefail

repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
out="${BROODS_CLOUD_DIR:-$HOME/.broods-cloud}"
test_home="$out/test-account"
dev_gateway=gateway.dev.broods.app
prod_gateway=gateway.broods.app
login=false
for arg in "$@"; do
  case "$arg" in
    --login) login=true ;;
    *) echo "cloud-setup: unknown option $arg" >&2; exit 1 ;;
  esac
done
mkdir -p "$out" "$test_home"
chmod 700 "$out" "$test_home"

if $login; then
  broods_bin=$(command -v broods || true)
  [ -n "$broods_bin" ] || { echo "cloud-setup: install the CLI first (bun add -g broods)" >&2; exit 1; }
  # No browser launch: your normal browser is signed in as you, not the test user.
  shim=$(mktemp -d)
  printf '#!/bin/sh\nexit 0\n' >"$shim/xdg-open"
  cp "$shim/xdg-open" "$shim/open"
  chmod +x "$shim/xdg-open" "$shim/open"
  for dashboard in dashboard.dev.broods.app dashboard.broods.app; do
    echo "== $dashboard: open the URL below in a private window, sign in as the test user"
    # From $test_home: login writes .env.local defaults into the current dir.
    (cd "$test_home" && HOME="$test_home" PATH="$shim:$PATH" "$broods_bin" login --dashboard-url "https://$dashboard")
  done
  rm -rf "$shim"
fi

bun_version=$(tr -d '[:space:]' <"$repo/.bun-version") || true
playwright_version=$(grep -o '"playwright@[0-9.]*"' "$repo/bun.lock" | head -1 | tr -d '"' | cut -d@ -f2) || true
lean_toolchain=$(tr -d '[:space:]' <"$repo/verification/lean-toolchain") || true
convex_image=$(grep -o 'ghcr.io/convex/convex-backend@sha256:[0-9a-f]*' "$repo/scripts/local-stack.ts" | head -1) || true
traefik_image=$(grep -o 'TRAEFIK_IMAGE = "[^"]*"' "$repo/scripts/local-stack.ts" | cut -d'"' -f2) || true
for name in bun_version playwright_version lean_toolchain convex_image traefik_image; do
  [ -n "${!name}" ] || { echo "cloud-setup: could not read $name from the checkout" >&2; exit 1; }
done

# A linked worktree has no .env.local of its own: fall back to the main checkout's.
main_checkout=$(dirname "$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)")
dashboard_env="$repo/apps/dashboard/.env.local"
[ -f "$dashboard_env" ] || dashboard_env="$main_checkout/apps/dashboard/.env.local"
from_dotenv() {
  [ -f "$dashboard_env" ] || return 0
  grep -m1 "^$1=" "$dashboard_env" | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/' || true
}
# The probe's login only: a person's own token must never reach a cloud session.
from_login() {
  [ -f "$test_home/.broods/config.json" ] || return 0
  CONFIG="$test_home/.broods/config.json" SERVER="https://$1" PROBE="$e2e_email" bun -e '
    const login = JSON.parse(await Bun.file(process.env.CONFIG).text()).logins?.[process.env.SERVER];
    if (login && login.user?.email !== process.env.PROBE) {
      console.error(`cloud-setup: ${process.env.SERVER} login is ${login.user?.email}, not the probe ${process.env.PROBE}; ignored`);
    } else process.stdout.write(login?.token ?? "");' || true
}
pick() { local v="${!1:-}"; [ -n "$v" ] && printf %s "$v" || printf %s "$2"; }

e2e_email=$(pick E2E_EMAIL "$(from_dotenv E2E_EMAIL)")
e2e_password=$(pick E2E_PASSWORD "$(from_dotenv E2E_PASSWORD)")
dev_token=$(pick BROODS_DEV_TOKEN "$(from_login "$dev_gateway")")
prod_token=$(pick BROODS_PROD_TOKEN "$(from_login "$prod_gateway")")
anthropic_key="${ANTHROPIC_API_KEY:-}"
openai_key="${OPENAI_API_KEY:-}"

umask 077

cat >"$out/setup.sh" <<EOF
#!/bin/bash
# Generated by scripts/cloud-setup.sh. Runs as root before Claude Code starts;
# cached ~7 days when it ends in ~5 min. Per-session work (dockerd, bun install)
# is scripts/cloud-session-start.sh, wired in .claude/settings.json.
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive

npm install -g "bun@${bun_version}" >/tmp/setup-bun.log 2>&1 || true

if ! docker info >/dev/null 2>&1; then
  (dockerd >/tmp/dockerd.log 2>&1 &)
  for _ in \$(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
fi
timeout 240 docker pull "${convex_image}" >/tmp/setup-convex.log 2>&1 &
timeout 240 docker pull "${traefik_image}" >/tmp/setup-traefik.log 2>&1 &
timeout 240 npx -y "playwright@${playwright_version}" install --with-deps chromium >/tmp/setup-playwright.log 2>&1 &
(timeout 240 bash -c 'curl -sSf https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh |
  sh -s -- -y --default-toolchain "${lean_toolchain}" && "\$HOME"/.elan/bin/elan toolchain install "${lean_toolchain}"' >/tmp/setup-lean.log 2>&1 &&
  ln -sf "\$HOME"/.elan/bin/* /usr/local/bin/) &
# User-scope plugins never reach a cloud session, so install them here.
(timeout 240 claude plugin marketplace add anthropics/claude-plugins-official &&
  for p in code-simplifier commit-commands frontend-design; do
    timeout 60 claude plugin install "\${p}@claude-plugins-official" --scope user
  done) >/tmp/setup-plugins.log 2>&1 &

wait
# Stop dockerd so the cached snapshot holds a clean /var/lib/docker.
pkill dockerd 2>/dev/null && for _ in \$(seq 1 20); do pgrep dockerd >/dev/null || break; sleep 1; done
exit 0
EOF

cat >"$out/env.txt" <<EOF
BROODS_DEV_TOKEN=${dev_token}
BROODS_PROD_TOKEN=${prod_token}
E2E_EMAIL=${e2e_email}
E2E_PASSWORD=${e2e_password}
CLOUD_ANTHROPIC_API_KEY=${anthropic_key}
OPENAI_API_KEY=${openai_key}
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
EOF

rm -f "$out/network-secrets.txt"
chmod 600 "$out/setup.sh" "$out/env.txt"

echo "Wrote $out/{setup.sh,env.txt}. Delete any broods network secrets from the environment."
missing=()
for pair in "BROODS_DEV_TOKEN:$dev_token" "BROODS_PROD_TOKEN:$prod_token" "E2E_EMAIL:$e2e_email" \
  "E2E_PASSWORD:$e2e_password" "ANTHROPIC_API_KEY:$anthropic_key" "OPENAI_API_KEY:$openai_key"; do
  [ -n "${pair#*:}" ] || missing+=("${pair%%:*}")
done
[ ${#missing[@]} -eq 0 ] || echo "Empty, set in env and rerun: ${missing[*]}"
[ -n "$dev_token$prod_token" ] || echo "No test-account login yet: run bash scripts/cloud-setup.sh --login"
