---
name: strict-review
description: Full review of a diff against the repo rules, not just bugs. Use when the user asks to review, strict-review, or check a branch, commit range or PR before it ships. Covers correctness, naming, file order, new functions, the solution itself, public contract changes that need a mock and approval, and runs lint, types and tests.
argument-hint: "[low|medium|high|xhigh|max] [pr number | branch | commit range]"
---

# Strict review

`/code-review` hunts bugs and some cleanup. This skill adds the rules it skips and the checks it never runs. Default level is `high`. Default target is `git diff @{upstream}...HEAD` plus uncommitted changes.

## 1. Bugs and cleanup

Run `/code-review <level> <target>` through the Skill tool. It covers correctness, reuse, simplification, efficiency, altitude, and the rules in every `CLAUDE.md` (they import `AGENTS.md`). Keep its findings. Do not repeat its angles below.

## 2. Rules it skips

Read every changed file in full, not only the hunks. Read the root `AGENTS.md`, the `AGENTS.md` of each touched workspace, and `~/.claude/CLAUDE.md`. Quote the rule and the line for each finding.

**Naming.** Every new or renamed identifier, file and route:

- Says what it holds or does in plain words. No `data`, `info`, `item`, `obj`, `tmp`, `handle`, `util`, `helper`, `manager`, or unexplained abbreviations.
- Booleans read as a question: `is`, `has`, `can`, `should`.
- Same concept, same word as the rest of the codebase. Grep the name; flag a new synonym for an existing term.
- Case matches its neighbours: camelCase values and functions, PascalCase types and components, UPPER_SNAKE module constants, file names as the folder already names them.
- Shortest name that stays unambiguous in its scope.

**File order and structure.** Constants, types and interfaces, exports and main logic, private helpers. Same-kind functions grouped and sorted alphabetically. Imports at the top unless lazy with a reason. One blank line before the trailing `return`. Explicit return types, no `satisfies`, no `any`, no shorthand `key` in object literals, no one-line cast functions. A comment above each function or class says how it is used, and matches the code.

**New functions and exports.** List each one. Grep for existing code that does the same. Flag it unless its behavior really differs. Flag new code that grows a file or module when a smaller change to existing code would do.

**The solution.** State in one line what the change is for (commit message, PR body). Then check:

- It fixes that at the root, with the least code. No speculative options, flags or layers (YAGNI).
- No scope creep past the goal.
- No compat shim for a dead record format or old id.
- No `isRecord` or `isPlainObject` in new code; the real type exists or was written.
- Tests are focused on the new behavior. No smoke tests, no tests for deleted features.

## 3. Public contract gate

A change is a public contract change when it touches any of:

- HTTP routes, request or response shapes in `apps/gateway` or `apps/core`, or `apps/docs/docs/api-reference/openapi.yaml`
- Exports or types of the published `broods` package (`packages/broods`), including CLI commands, flags, prompts and output
- Public Convex functions or schema in `packages/convex`
- Anything a user sees in `apps/dashboard`

For each one, the review must find:

1. **Walked**: openapi, docs, `packages/demos`, SDK types and client, and a focused test all move with it (`AGENTS.md`).
2. **Mock**: for UI, CLI output or API shape changes, a published mock or proposal link in the PR body or commit.
3. **Approval**: the user's explicit OK on that mock, quoted from the PR or conversation.

Missing any of the three is a **blocking** finding. Never infer approval.

## 4. Required steps

Flag as blocking when missing:

- Convex schema or function change: the `_generated` diff from `bun run --filter @broods/convex codegen` is committed.
- End-to-end behavior change in core, gateway, convex, SDK or CLI: a case added or updated in `scripts/local-verify/cases/`.
- Per-turn path touched: perf budget in `scripts/local-verify/perf-baseline.json` still holds, or was lowered with `local:perf -- --record`.

## 5. Run the checks

Run these from the repo root and report pass or fail with the failing output. Do not fix during the review.

```bash
bun run lint
bun run format:check
bun run --filter <each touched workspace> check
bun run --filter <each touched workspace> test
```

- Unsafe types on the changed `.ts` files only, so the `lint:types` backlog does not drown them: `bunx oxlint --type-aware -A all -D typescript/no-explicit-any -D typescript/no-unsafe-type-assertion -D typescript/no-unsafe-argument -D typescript/no-unsafe-assignment <files>`. Flag only findings on lines the diff adds.
- `openapi.yaml` touched: `oasdiff breaking <base spec> <new spec> --fail-on ERR` (base from `git show <base>:apps/docs/docs/api-reference/openapi.yaml`). Any breaking change needs the section 3 approval.
- `packages/broods` touched: `bun run --filter broods pack:check`. For the CLI, diff `--help` of each changed command against the base.
- `apps/dashboard` UI touched: `bun run --filter @broods/dashboard test:ui`, and attach a screenshot of the changed screen.
- Never run raw `tsc` from the root. Tools built on the TypeScript compiler API (type-coverage, dependency-cruiser, typescript-eslint) do not run on TS 7.0; do not reach for them.

Say which checks you skipped and why. `local:verify` needs Docker and `DEEPSEEK_API_KEY`; run it when section 4 applies and they are available, otherwise say it did not run.

## Report

One list, most severe first, in three groups: **Blocking** (bugs, gate failures, failed checks), **Should fix** (rules, naming, structure), **Nit**. Each finding: `file:line`, the rule quoted, what to change. Then a table of the checks run with pass or fail. End with the contract changes found and their mock and approval status.
