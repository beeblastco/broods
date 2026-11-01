#!/usr/bin/env bash
# SessionStart hook (.claude/settings.json). Claude Code cloud sessions only:
# start dockerd, install deps when the lockfile moved, wire git hooks, fetch the
# baseline ref, name this session's broods project ($BROODS_CLOUD_PROJECT). Exits at once anywhere else. Toolchain comes from the setup
# script that scripts/cloud-setup.sh generates.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

if ! docker info >/dev/null 2>&1; then
  (dockerd >/tmp/dockerd.log 2>&1 &)
  for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
fi

git config core.hooksPath .githooks

# stdout reaches the model: name any install the setup script could not do.
if [ -s /var/lib/broods-cloud-setup-failed ]; then
  echo "cloud-session-start: the environment's setup script failed to install:"
  cat /var/lib/broods-cloud-setup-failed
fi

stamp=node_modules/.cloud-install.sha256
if ! sha256sum --check --status "$stamp" 2>/dev/null; then
  rm -f "$stamp"
  if bun install --frozen-lockfile >/tmp/bun-install.log 2>&1 ||
    bun install --frozen-lockfile --cafile /etc/ssl/certs/ca-certificates.crt >>/tmp/bun-install.log 2>&1; then
    sha256sum package.json bun.lock >"$stamp"
  else
    # stdout reaches the model, so the agent knows deps are missing.
    echo "cloud-session-start: bun install failed, see /tmp/bun-install.log"
  fi
fi

timeout 60 git fetch origin dev --quiet 2>/dev/null || true

# One broods project per cloud session, in the shared test account, so parallel
# sessions never touch each other's stage. Same id on resume = same project.
if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${CLAUDE_CODE_REMOTE_SESSION_ID:-}" ]; then
  # The env file and its scratch copies hold the Anthropic key: owner only,
  # and no scratch file outlives an interrupted run.
  umask 077
  trap 'rm -f "$CLAUDE_ENV_FILE.tmp" "$CLAUDE_ENV_FILE.broods"' EXIT
  id=$(printf %s "${CLAUDE_CODE_REMOTE_SESSION_ID#cse_}" | tr -cd 'A-Za-z0-9' | tr 'A-Z' 'a-z' | tail -c 12)
  # broods-dev / broods-prod: the CLI from source (no build), pointed at one
  # server. The token is read when the command runs, never written down, so
  # printing the environment shows no secret. The prod token can write:
  # prod stays read-only only because AGENTS.md tells the agent so.
  bin="$HOME/.local/bin"
  mkdir -p "$bin"
  for target in dev:gateway.dev.broods.app:dashboard.dev.broods.app:BROODS_DEV_TOKEN \
    prod:gateway.broods.app:dashboard.broods.app:BROODS_PROD_TOKEN; do
    IFS=: read -r name gateway dashboard token <<<"$target"
    cat >"$bin/broods-$name" <<EOF
#!/bin/sh
BROODS_BASE_URL=https://$gateway BROODS_DASHBOARD_URL=https://$dashboard BROODS_TOKEN="\$$token" \\
  exec bun "$CLAUDE_PROJECT_DIR/packages/broods/src/cli/index.ts" "\$@"
EOF
    chmod +x "$bin/broods-$name"
  done
  {
    # Not BROODS_PROJECT: the CLI and its tests read that one from the shell.
    echo "export BROODS_CLOUD_PROJECT=cloud-$id"
    echo "export PATH=\"$bin:\$PATH\""
    # A session drops ANTHROPIC_API_KEY from the environment; local:verify
    # reads it for real-model runs, so cloud-setup ships it under this name.
    [ -n "${CLOUD_ANTHROPIC_API_KEY:-}" ] && printf 'export ANTHROPIC_API_KEY=%q\n' "$CLOUD_ANTHROPIC_API_KEY"
  } >"$CLAUDE_ENV_FILE.broods"
  grep -v -e '^export BROODS_CLOUD_PROJECT=' -e "^export PATH=\"$bin:" -e '^export ANTHROPIC_API_KEY=' "$CLAUDE_ENV_FILE" 2>/dev/null >"$CLAUDE_ENV_FILE.tmp" || true
  cat "$CLAUDE_ENV_FILE.tmp" "$CLAUDE_ENV_FILE.broods" >"$CLAUDE_ENV_FILE"
  rm -f "$CLAUDE_ENV_FILE.tmp" "$CLAUDE_ENV_FILE.broods"
fi
exit 0
