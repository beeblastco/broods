---
name: strict-review
description: Full pre-merge review of a PR or branch the way Phicks would, against their vision and the repo rules, with checks and dashboard evidence. Use only when the user asks for strict-review or a full review before merging, or when /merge-pr needs it. For a quick bug pass use /code-review.
argument-hint: "[low|medium|high|xhigh|max] [pr | branch | commit range]"
---

# Strict review

Review with Phicks's eyes. `/code-review` finds bugs; this checks the change against the rules and shows Phicks what they need to judge the rest. The exact rules live in the root and touched workspaces' `AGENTS.md` and `~/.claude/CLAUDE.md`; read them, do not restate them. The principles below are why those rules exist.

You own the verdict on rules, bugs, checks and evidence. Phicks owns taste and whether the solution is the right one: raise those for them, never as a verdict.

## What they want, and why

- **Less is the job.** Every line is debt in a big codebase. Ask: could this be less code, an existing function, or no change at all? A new function, option, layer or flag must earn its place now (YAGNI), not someday.
- **Types carry the truth.** Real and inferred types let the system adapt when something changes; `any`, casts and runtime guards hide the break until production. Ask: would a change elsewhere fail the type check here?
- **Fix the cause, not the symptom.** Dead formats get a clean reset, not a compat shim.
- **One product.** Gateway, core, Convex, SDK, CLI, dashboard and docs are one system. A contract that moves in one and not the others is a bug a user hits later.
- **The user sees it before it is built.** Interface changes cost users, so Phicks sees a mock first (step 3).
- **Plain names.** A name says what the thing holds and reuses the codebase's existing words.
- **Done means proven.** A claim needs a command that ran (step 5).

## Steps

1. **Base review.** Check out the target's head in its own worktree and set `B=$(git merge-base <target base> HEAD)`; every diff below is against `$B`. Run `/code-review <level> <target>`, default `high`. Keep its findings; do not repeat its angles.
2. **Rules and principles.** Read every changed file in full, not only the hunks. A broken rule is a finding: quote the rule and the line. Where only a principle speaks, or you doubt the approach itself, raise it for Phicks.
3. **Contract gate.** When a request or response shape, an SDK export, a CLI command or flag, or a public Convex function's signature changes, the other surfaces must move with it. That change, and any non-trivial dashboard UI, layout or copy change, is blocking without a linked mock and quoted approval from Phicks. Internal changes behind an unchanged contract pass. Never infer approval.
4. **Bugs.** Confirm each correctness finding with a red loop from `/diagnosing-bugs` phases 1 and 2 before calling it blocking; delete the repro before step 5. Unconfirmed stays plausible. Fixes go through `/diagnosing-bugs`.
5. **Checks.** Run the `AGENTS.md` before-done commands in their check form (`format:check`, never `format` or `lint:fix`), the tests for each touched workspace, and `local:verify` and `local:perf` when `AGENTS.md` calls for them (`local:up`, with `-- --perf` for perf, first; `local:down` after). A check that leaves the tree changed is a finding. Type-aware lint: `bun run lint:types -- -D typescript/no-explicit-any -D typescript/no-unsafe-type-assertion <files>`, keeping only findings on lines `git diff -U0 $B` adds. The OpenAPI spec changed: `oasdiff breaking $B:apps/docs/docs/api-reference/openapi.yaml apps/docs/docs/api-reference/openapi.yaml --fail-on ERR` (`brew install oasdiff`). `packages/broods` changed: `bun run --filter broods pack:check`. Say what you skipped and why.
6. **Dashboard evidence.** A UI change in `apps/dashboard` must ship with a live demo, a perf report and screenshots; missing any is blocking. Produce them yourself, running the dashboard as `apps/dashboard/AGENTS.md` describes: `next dev` on a `.env.local` copied from the main checkout, signed in only as the E2E probe user (`E2E_EMAIL`, `E2E_PASSWORD`, saved in that `.env.local`) against the dev backend, the way CI does. Never production, never a real account; ask Phicks only when the main checkout's `.env.local` has no probe login. Keep secret and env screens out of every recording. Drive the changed flow with Playwright, recording video and a screenshot of each changed screen in light and dark, then run `bun run --filter @broods/dashboard perf`. Check them yourself: watch the demo, look at every screenshot against `apps/dashboard/AGENTS.md` and the design rules in `~/.claude/CLAUDE.md`, and block any page over `PAGE_RENDER_BUDGET_MS`. Publish one artifact page with the video and screenshots as its files and the perf numbers, and post its link as a PR comment, or in the report when the target is not a PR.
7. **The cycle.** Check, do not do: the branch is up to date with the latest default branch (rebased before the PR opened, the default branch merged in after it was pushed, never force-pushed), commits and PR are in plain words that open with the user's problem, and the PR was filed with `/file-pr`.

## Report

Open with **Blocked on me**: taste and solution questions, each with what you saw, the options and the evidence link, then any blocking finding that needs Phicks. Then the rest of the findings, most severe first: `file:line`, the rule, the fix. Then the checks with pass or fail, the dashboard evidence link, and each contract change with its mock and approval status.

## Taste notes

When Phicks overrules a finding, or flags something the review missed, propose one line for here: what they said, and the why. On their yes, land it through its own `/file-pr` PR, never inside the PR under review. Read these before step 2.

- _(none yet)_
