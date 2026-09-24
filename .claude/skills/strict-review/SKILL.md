---
name: strict-review
description: Review a diff against the repo rules, not just bugs. Use when the user asks to review, strict-review, or check a branch, commit range or PR before it ships.
argument-hint: "[low|medium|high|xhigh|max] [pr | branch | commit range]"
---

# Strict review

Adds what `/code-review` misses. Do not repeat its angles or restate rules here; the rules live in the root `AGENTS.md`, the touched workspaces' `AGENTS.md`, and `~/.claude/CLAUDE.md`.

1. **Base review.** Run `/code-review <level> <target>`, default `high`. Keep its findings.
2. **Rules.** `/code-review` reads only `CLAUDE.md` files, so read the rule files above yourself and check every changed file in full, not only the hunks. Include file order and naming: plain, intuitive names that reuse the codebase's existing terms. Quote the rule and the line.
3. **Contract gate.** A change to an API route or `openapi.yaml`, the SDK or CLI in `packages/broods`, a public Convex function, or dashboard UI is blocking unless the other surfaces moved with it (`AGENTS.md`), a mock is linked, and the user's approval of it is quoted. Never infer approval.
4. **Bugs.** Confirm each correctness finding with a red loop from `/diagnosing-bugs` phases 1 and 2 before calling it blocking; throwaway, not committed. Unconfirmed stays plausible. Fixes go through `/diagnosing-bugs`.
5. **Checks.** Run the `AGENTS.md` before-done commands and tests for each touched workspace. Also, only for lines the diff adds: `bunx oxlint --type-aware -A all -D typescript/no-explicit-any -D typescript/no-unsafe-type-assertion <files>`. `openapi.yaml` changed: `oasdiff breaking`. `packages/broods` changed: `pack:check`. Say what you skipped and why.

Report most severe first as blocking, should fix, nit: `file:line`, the rule, the fix. Then the checks with pass or fail, and each contract change with its mock and approval status.
