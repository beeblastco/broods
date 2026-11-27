#!/usr/bin/env bash
# SessionStart hook (.claude/settings.json), Claude Code cloud sessions only:
# names this session's dev project, installs broods-dev, then
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
  # This checkout's CLI from source, pointed at dev; the token is read when the
  # command runs, never written down. Sessions get no prod access at all.
  bin="$HOME/.local/bin"
  mkdir -p "$bin"
  cat >"$bin/broods-dev" <<EOF
#!/bin/sh
BROODS_BASE_URL=https://gateway.dev.broods.app BROODS_DASHBOARD_URL=https://dashboard.dev.broods.app BROODS_TOKEN="\$BROODS_DEV_TOKEN" \\
  exec bun "$CLAUDE_PROJECT_DIR/packages/broods/src/cli/index.ts" "\$@"
EOF
  chmod +x "$bin/broods-dev"
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
