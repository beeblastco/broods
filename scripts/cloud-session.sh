#!/bin/bash
# SessionStart hook (.claude/settings.json) for Claude Code cloud sessions.
# Makes a fresh cloud VM ready for `bun run check`, tests and `local:up` /
# `local:verify`: dependencies installed, git hooks wired, Docker daemon up.
# Exits at once outside the cloud, so local sessions are untouched.
# The cloud environment itself (model, effort, setup script) is described in
# AGENTS.md under "Cloud sessions".

[ "$CLAUDE_CODE_REMOTE" = "true" ] || exit 0
cd "$CLAUDE_PROJECT_DIR" || exit 1

# The VM boots without dockerd; the local stack runs Convex and Traefik in it.
if ! docker info >/dev/null 2>&1; then
  nohup dockerd >/tmp/dockerd.log 2>&1 &
fi

# bun install --ignore-scripts skips `prepare`, so wire the pre-commit hook here.
git config core.hooksPath .githooks

# Same flags as CI. Skipped while bun.lock is unchanged since the last success.
stamp=node_modules/.cloud-session.sha256
if ! sha256sum --check --status "$stamp" 2>/dev/null; then
  rm -f "$stamp"
  bun install --frozen-lockfile --ignore-scripts >&2 && sha256sum bun.lock >"$stamp"
fi

for _ in $(seq 1 30); do
  docker info >/dev/null 2>&1 && exit 0
  sleep 1
done
echo "dockerd did not start, see /tmp/dockerd.log" >&2
exit 0
