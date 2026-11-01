---
name: broods-cloud-run
description: End-to-end procedure for a broods request, made for Claude Code cloud sessions - branch, build, verify on the local stack, compare baseline (origin/dev) vs candidate with numbers, try the new CLI and dashboard, open a PR to dev, publish a report. Use for any implement, test, compare or research request on this repo when working unattended.
---

# Broods cloud run

Request in, PR and report out. Every number in the report comes from a command
you ran in this session. Root and workspace `AGENTS.md` still apply.

## 1. Branch

`git switch -c claude/<slug> origin/dev`. Read the `AGENTS.md` of each workspace you touch.

## 2. Build and static checks

- each touched workspace: `bun run --filter <pkg> check`; root `bun run lint`, `bun run format`.
- focused tests: `bun test <paths>` or `bun run --filter <pkg> test`.
- Convex change: `bun run --filter @broods/convex codegen`, commit `_generated`.
- `verification/` mirrored code touched: `cd verification && lake build`.

Log each command and its result.

## 3. Candidate end to end

```bash
bun run local:up -- --perf      # add --dashboard when UI matters
bun run local:verify
bun run local:perf
bun run bench
bun run local:down
```

End-to-end behavior changed = add or update a case in `scripts/local-verify/cases/`.
`ANTHROPIC_API_KEY` set means real model calls that cost money: use it only when the request touches the model path.

## 4. Baseline

```bash
git worktree add ../broods-base origin/dev
cd ../broods-base && bun install --frozen-lockfile
bun run local:up -- --perf && bun run local:verify && bun run local:perf && bun run bench && bun run local:down
```

Stacks are keyed by worktree so they never collide, but run them one after the
other (4 vCPU, 16 GB). Run perf and bench at least 3 times per side; report median and spread.

## 5. New CLI and SDK, on this session's own project

Every session acts as the shared probe account and works in its own project,
`$BROODS_CLOUD_PROJECT` (`cloud-<session id>`), on its default `development` stage. Never touch another `cloud-*` project: a
parallel session owns it. The session-start hook installs `broods-dev` (dev, read and
write) and `broods-prod` (prod, read-only) on PATH. Both run this checkout's CLI from
source, so every edit is live with no build, and read the token only when they run.

```bash
mkdir -p /tmp/$BROODS_CLOUD_PROJECT && cd /tmp/$BROODS_CLOUD_PROJECT   # folder name = project name
broods-dev init
echo "OPENAI_API_KEY=$OPENAI_API_KEY" >> .env.local   # dev pushes env() values from .env.local only
broods-dev dev --once                             # first sync creates the project
broods-dev whoami
broods-prod whoami                                # prod: whoami, list, read only
```

`broods-dev run my-agent "..." < /dev/null` answers in plain text: it signs a user token with the
`BROODS_USER_TOKEN_SECRET` that `dev` wrote to `.env.local`.
Capture exact commands and output.

## 6. Dashboard

- local: `bun run local:up -- --dashboard`, then in `apps/dashboard`:
  `E2E_ADMIN_KEY=$(bun scripts/local-stack.ts status --key) E2E_BASE_URL=<printed url> bun run test:app` (and `perf`).
- dev: `E2E_BASE_URL=https://dashboard.dev.broods.app E2E_PROJECT_ID=<id of $BROODS_CLOUD_PROJECT>`
  with `E2E_EMAIL`, `E2E_PASSWORD` (the probe). The id is in the dashboard URL of the project.
- prod: browse read-only with the same user. No writes.

Keep screenshots and traces as evidence.

## Clean up

Before the final reply: `broods-dev project delete "$BROODS_CLOUD_PROJECT" --yes`, unless the user
asked to keep it (then put its dashboard URL in the report). Run `bun run local:down` in each worktree.

## 7. Report

Table per metric, `baseline (sha) | candidate (sha) | delta | delta %`: local:perf p50/p95 per
scenario, Convex calls per turn by function, bench numbers, bundle sizes, verify cases and
test counts pass/fail. Then: what changed, what was verified and how, what was not and why,
the raw command log. Publish it with a report or artifact skill when one is loaded, else commit
`reports/<slug>.md` on the branch. Include the session URL:
`echo "https://claude.ai/code/${CLAUDE_CODE_REMOTE_SESSION_ID/#cse_/session_}"`.

## 8. PR

Commit, push `claude/<slug>`, open the PR against `dev` with the built-in GitHub tool
(`gh pr` and `gh issue` hit a GraphQL 403 behind the cloud proxy; use `gh api repos/beeblastco/broods/...` REST for anything the built-in tools lack).
Body: summary, verification table, report link, session URL. Never merge. Final reply to
the user: PR URL, report URL, one line per headline number.
