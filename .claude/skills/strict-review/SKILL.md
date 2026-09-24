---
name: strict-review
description: Review a diff the way Phicks would, against their vision and the repo rules, not just bugs. Use when the user asks to review, strict-review, or check a branch, commit range or PR before it ships.
argument-hint: "[low|medium|high|xhigh|max] [pr | branch | commit range]"
---

# Strict review

Review with Phicks's eyes. `/code-review` finds bugs; this checks the change against the rules and shows Phicks what they need to judge the rest. The exact rules live in the root and touched workspaces' `AGENTS.md` and `~/.claude/CLAUDE.md`; read them, do not restate them. The principles below are why those rules exist.

You own the verdict on rules, bugs, checks and evidence. Phicks owns taste and whether the solution is the right one: raise those under **Your call** with what you saw and the options, never as a verdict or a blocker.

## What they want, and why

- **Less is the job.** Every line is debt in a big codebase. Ask: could this be less code, an existing function, or no change at all? A new function, option, layer or flag must earn its place now (YAGNI), not someday.
- **Types carry the truth.** Real and inferred types let the system adapt when something changes; `any`, casts and runtime guards hide the break until production. Ask: would a change elsewhere fail the type check here?
- **Fix the cause, not the symptom.** A workaround that needs a paragraph to justify it means the code is wrong. Dead formats get a clean reset, not a compat shim.
- **One product.** Gateway, core, Convex, SDK, CLI, dashboard and docs are one system. A contract that moves in one and not the others is a bug a user hits later.
- **The user sees it before it is built.** Interface changes (API, SDK, CLI, dashboard) cost users, so they need a mock and an explicit yes from Phicks first. Results show where the action happened.
- **Read top-down, like prose.** Overview, then detail, then helpers; plain names that say what a thing holds, reusing the codebase's existing words. Short comments say how a thing is used, and match the code.
- **Dense, quiet UI.** Information over decoration, minimal copy, nothing that repaints forever.
- **Done means proven.** A claim needs a command that ran. Tests are focused on the new behavior; no smoke tests, no tests for deleted things.
- **Blast radius.** Nothing touches production, live data, deploys or force-pushes without a word from Phicks.

## Steps

1. **Base review.** Run `/code-review <level> <target>`, default `high`. Keep its findings; do not repeat its angles.
2. **Rules and principles.** Read every changed file in full, not only the hunks. A broken rule is a finding: quote the rule and the line. Where only a principle speaks, or you doubt the approach itself, put it under **Your call**.
3. **Contract gate.** An API route or `openapi.yaml`, the SDK or CLI in `packages/broods`, a public Convex function, or dashboard UI is blocking unless the other surfaces moved with it, a mock is linked, and approval from Phicks is quoted. Never infer approval.
4. **Bugs.** Confirm each correctness finding with a red loop from `/diagnosing-bugs` phases 1 and 2 before calling it blocking; throwaway, not committed. Unconfirmed stays plausible. Fixes go through `/diagnosing-bugs`.
5. **Checks.** Run the `AGENTS.md` before-done commands and tests for each touched workspace. For lines the diff adds: `bunx oxlint --type-aware -A all -D typescript/no-explicit-any -D typescript/no-unsafe-type-assertion <files>`. `openapi.yaml` changed: `oasdiff breaking`. `packages/broods` changed: `pack:check`. Say what you skipped and why.
6. **Dashboard evidence.** Any change to `apps/dashboard` UI must ship with a live demo, its perf report and screenshots; missing any is blocking. Produce them yourself from the PR branch: `bun run local:up`, then `bun run dashboard`, then drive the changed flow with Playwright, recording video and a screenshot of each changed screen in light and dark. Run `bun run --filter @broods/dashboard perf` against that server (setup in `apps/dashboard/AGENTS.md`), and again on the base branch for comparison. Then check them yourself: watch the demo, look at every screenshot against the principles and `apps/dashboard/AGENTS.md`, and flag any page over `PAGE_RENDER_BUDGET_MS` or slower than the base. Publish the video, screenshots and perf numbers with `/communication-artifact` and link it in the PR body.
7. **The cycle.** Branch rebased on the latest default branch, commits and PR in plain words that open with the user's problem, PR filed with `/file-pr`.

## Report

Open with **Your call**: taste and solution questions, each with what you saw, the options, and the evidence link. Then blocking, should fix, nit, most severe first: `file:line`, the rule, the fix. Then the checks with pass or fail, the dashboard evidence link, and each contract change with its mock and approval status.

## Taste notes

When Phicks overrules a finding, or flags something the review missed, add one line here: what they said, and the why. Read these before step 2.

- _(none yet)_
