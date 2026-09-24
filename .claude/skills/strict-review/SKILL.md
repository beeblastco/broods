---
name: strict-review
description: Full pre-merge review of a PR or branch the way Phicks would, against their vision and the repo rules, with checks and dashboard evidence. Use only when the user asks for strict-review or a full review before merging, or when /merge-pr needs it. For a quick bug pass use /code-review.
argument-hint: "[low|medium|high|xhigh|max] [pr | branch | commit range]"
---

# Strict review

Review with Phicks's eyes. `/code-review` finds bugs; this checks the change against the rules and shows Phicks what they need to judge the rest. The exact rules live in the root and touched workspaces' `AGENTS.md` and `~/.claude/CLAUDE.md`; read them, do not restate them. The principles below are why those rules exist.

You own the verdict on rules, bugs, checks and evidence. Phicks owns taste and whether the solution is the right one: raise those under **Blocked on me** with what you saw and the options, never as a verdict.

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
2. **Rules and principles.** Read every changed file in full, not only the hunks. A broken rule is a finding: quote the rule and the line. Where only a principle speaks, or you doubt the approach itself, raise it for Phicks.
3. **Contract gate.** When a request or response shape, an SDK export, a CLI command or flag, or a public Convex function's signature changes, the other surfaces must move with it. That change, and any non-trivial dashboard UI, layout or copy change, is blocking without a linked mock and quoted approval from Phicks. Internal changes behind an unchanged contract pass. Never infer approval.
4. **Bugs.** Confirm each correctness finding with a red loop from `/diagnosing-bugs` phases 1 and 2 before calling it blocking; throwaway, not committed. Unconfirmed stays plausible. Fixes go through `/diagnosing-bugs`.
5. **Checks.** Run the `AGENTS.md` before-done commands in their check form (`format:check`, never `format` or `lint:fix`), the tests for each touched workspace, and `local:verify` and `local:perf` when `AGENTS.md` calls for them. A check that leaves the tree changed is a finding. Type-aware lint: `bunx oxlint --type-aware -D typescript/no-explicit-any -D typescript/no-unsafe-type-assertion <files>`, keeping only findings on lines `git diff -U0` adds. The OpenAPI spec changed: `oasdiff breaking <base>:apps/docs/docs/api-reference/openapi.yaml apps/docs/docs/api-reference/openapi.yaml --fail-on ERR` (`brew install oasdiff`), with `<base>` the fetched PR target. `packages/broods` changed: `pack:check`. Say what you skipped and why.
6. **Dashboard evidence.** A UI change in `apps/dashboard` must ship with a live demo, a perf report and screenshots; missing any is blocking. Produce them yourself, running the dashboard as `apps/dashboard/AGENTS.md` describes (`next dev` on `.env.local`; `perf` needs `E2E_EMAIL` and `E2E_PASSWORD`, ask Phicks when they are missing). Drive the changed flow with Playwright, recording video and a screenshot of each changed screen in light and dark, then run `bun run --filter @broods/dashboard perf`. Check them yourself: watch the demo, look at every screenshot against the principles and `apps/dashboard/AGENTS.md`, and block any page over `PAGE_RENDER_BUDGET_MS`. Publish one artifact page with the video and screenshots as its files and the perf numbers, and post its link as a PR comment.
7. **The cycle.** Check, do not do: the branch is rebased on the latest default branch, commits and PR are in plain words that open with the user's problem, and the PR was filed with `/file-pr`.

## Report

Open with **Blocked on me**: taste and solution questions, each with what you saw, the options and the evidence link, then any blocking finding that needs Phicks. Then the rest of the findings, most severe first: `file:line`, the rule, the fix. Then the checks with pass or fail, the dashboard evidence link, and each contract change with its mock and approval status.

## Taste notes

When Phicks overrules a finding, or flags something the review missed, propose one line for here: what they said, and the why. On their yes, land it through its own `/file-pr` PR, never inside the PR under review. Read these before step 2.

- _(none yet)_
