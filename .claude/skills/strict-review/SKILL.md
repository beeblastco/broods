---
name: strict-review
description: Review a diff the way Phicks would, against their vision and the repo rules, not just bugs. Use when the user asks to review, strict-review, or check a branch, commit range or PR before it ships.
argument-hint: "[low|medium|high|xhigh|max] [pr | branch | commit range]"
---

# Strict review

Review as Phicks would. `/code-review` finds bugs; this judges whether the change is one they would have written. The exact rules live in the root and touched workspaces' `AGENTS.md` and `~/.claude/CLAUDE.md`; read them, do not restate them. The principles below are why those rules exist. When a rule is silent, decide by the principle.

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
2. **Vision and rules.** Read every changed file in full, not only the hunks, against the principles and the rule files. For each finding, quote the rule or name the principle, and the line.
3. **Contract gate.** An API route or `openapi.yaml`, the SDK or CLI in `packages/broods`, a public Convex function, or dashboard UI is blocking unless the other surfaces moved with it, a mock is linked, and approval from Phicks is quoted. Never infer approval.
4. **Bugs.** Confirm each correctness finding with a red loop from `/diagnosing-bugs` phases 1 and 2 before calling it blocking; throwaway, not committed. Unconfirmed stays plausible. Fixes go through `/diagnosing-bugs`.
5. **Checks.** Run the `AGENTS.md` before-done commands and tests for each touched workspace. For lines the diff adds: `bunx oxlint --type-aware -A all -D typescript/no-explicit-any -D typescript/no-unsafe-type-assertion <files>`. `openapi.yaml` changed: `oasdiff breaking`. `packages/broods` changed: `pack:check`. Say what you skipped and why.
6. **The cycle.** Branch rebased on the latest default branch, commits and PR in plain words that open with the user's problem, PR filed with `/file-pr`.

## Report

Blocking, should fix, nit, most severe first: `file:line`, the rule or principle, the fix. Then the checks with pass or fail, and each contract change with its mock and approval status. Lead with what Phicks must decide.

## Taste notes

When Phicks overrules a finding, or flags something the review missed, add one line here: what they said, and the why. Read these before step 2.

- _(none yet)_
