#!/usr/bin/env bash
# SessionStart hook (.claude/settings.json), Claude Code cloud sessions only:
# names this session's dev project, installs broods-dev / broods-prod, then
# starts dockerd, installs deps when bun.lock moved and fetches origin/dev.
# Exits at once anywhere else. The toolchain comes from the setup script that
# scripts/cloud-setup.sh writes.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# Cheap and needed by every step, so first: a slow install that hits the hook
# timeout must not leave the session without them.
if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${CLAUDE_CODE_REMOTE_SESSION_ID:-}" ]; then
  # One project per session, so parallel sessions never share a stage.
  id=$(printf %s "${CLAUDE_CODE_REMOTE_SESSION_ID#cse_}" | tr -cd 'A-Za-z0-9' | tr 'A-Z' 'a-z' | tail -c 12)
  # This checkout's CLI from source, pointed at one server; the token is read
  # when the command runs, never written down. The prod token can write: prod
  # is read-only only because AGENTS.md says so.
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
  # Not BROODS_PROJECT: the CLI and its tests read that one from the shell.
  printf 'export BROODS_CLOUD_PROJECT=cloud-%s\nexport PATH="%s:$PATH"\n' "$id" "$bin" >>"$CLAUDE_ENV_FILE"
fi

if ! docker info >/dev/null 2>&1; then
  (dockerd >/tmp/dockerd.log 2>&1 &)
  for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
fi

git config core.hooksPath .githooks

# stdout reaches the model: name what the setup script or the install missed.
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
    echo "cloud-session-start: bun install failed, see /tmp/bun-install.log"
  fi
fi

# Into origin/dev itself: the skill branches and measures the baseline from it.
timeout 60 git fetch --quiet origin +refs/heads/dev:refs/remotes/origin/dev 2>/dev/null ||
  echo "cloud-session-start: git fetch of origin/dev failed, so it may be stale"
exit 0
