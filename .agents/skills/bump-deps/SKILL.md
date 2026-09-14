---
name: bump-deps
description: Land the weekly dependency bumps in the broods repo end to end. Use when Dependabot opens bump PRs, the dependency-watch issue opens, or when asked to bump, upgrade, or update dependency versions. Folds the bot PRs into one branch with a regenerated bun.lock, researches every release against the code, fixes what breaks, files and babysits the PR, merges to dev, watches the dev deploy, and promotes to prod.
---

# Bump dependencies

Dependabot edits `package.json` and never `bun.lock` in this workspaces repo, and CI installs with `--frozen-lockfile`, so every npm bump PR arrives red. Treat each one as notice that a release exists. The work lands as one PR from a branch you own.

Merging to dev and promoting to prod are part of this skill. Do both only when the user asked for the whole flow; otherwise stop at a green PR and report.

## 1. Collect

- `gh pr list --state open --author app/dependabot` for the bot PRs. `gh issue list --label dependency-watch --state open` for the watch issue. `.github/dependabot.yml` has the groups, the ignores, and the exact-pin rule.
- Work in a worktree branched from latest `origin/dev`, on a `chore/deps-<date>` branch.
- `gh pr diff <n> > <file>` for each PR, then `git apply` them one at a time. The groups overlap in `apps/core/package.json`. When a hunk fails on a line a neighbour PR changed, `git apply -C2`.
- `bun install --ignore-scripts`.
- `bun run deps:check`. By the time you act it is usually ahead of Dependabot. When it names a newer `ai` lockstep, move the whole family to it: exact pins on `ai` in core, `@ai-sdk/harness*`, `otel`, `policy-opa`, `tui`, and `packages/ai-sdk-sandbox`; caret provider floors raised to the latest. Reinstall until it prints "All watched dependencies are current."
- `grep -oE '"ai": \["ai@[^"]+"' bun.lock` prints exactly one line. A second copy of `ai` shows up as an unassignable `ChatTransport` in `packages/broods`, not as a version error.

## 2. Research

Read the changelog for every version in each range, not only the newest. Send one subagent per group (AI SDK, AWS SDK plus Pulumi, everything else). Each answers, per package:

1. What changed in the range that matters.
2. Which of our code touches it, with file:line.
3. Whether a feature's behavior changes, and why.
4. The code change needed, if any.
5. A workaround upstream now lets us delete.
6. Bug fixes that reach us.

Where to look:

- AI SDK: `vercel/ai`, `packages/<name>/CHANGELOG.md`. Harness patch releases have removed options before (adapter `model` in 1.0.104, `activeUserTools` in 1.0.93, provider-keyed `auth` in 1.0.92) and added builtins that pause a turn (`askUserQuestions` in 1.0.101). When a changelog line is vague, diff the published `.d.ts` of the old and new tarballs.
- AWS SDK: `gh release view v3.<n>.0 -R aws/aws-sdk-js-v3`, filtered to the clients in `apps/core/package.json` and `packages/convex/package.json`.
- Pulumi: the `@pulumi/*` versions in `apps/core/package.json` do not drive deploy. SST pins its own providers in `apps/core/sst.config.ts`, so these bumps cannot change the plan.
- React: the dashboard runs the copy Next.js bundles. The installed React only reaches `bun test` and types.
- A major: check its peers against what `bun.lock` actually resolves. If it does not fit, hold it with an `ignore` entry for `version-update:semver-major` in `.github/dependabot.yml`, with a comment saying what lifts the hold.
- A dependency no source file imports can still be load-bearing. `@docusaurus/theme-mermaid` imports `@mermaid-js/layout-elk` from its client bundle, so deleting that package breaks the docs build. Prove any removal with the hoisted docs build below, not with grep.

## 3. Verify

Run these one at a time. The probes in `apps/core/tests/ai-sdk-harness-runtime.test.ts` spawn child processes and hit the 5 s timeout when a docs build shares the CPU.

- `bun run check`
- `bun run test`. It chains core, convex, and broods with `&&`, so a core failure hides the other two. Run those separately when core fails.
- `bun run format`
- Docs. PR CI never builds them; Deploy Docs runs only on main. Build them the way that workflow does, in a scratch copy so the worktree keeps its isolated layout: `git archive` the branch into the job temp dir, then `bun install --ignore-scripts --no-save --linker hoisted` and `bun run docs:build` there. Under the default isolated linker `@docusaurus/theme-common` splits into two copies and every mermaid page fails with `ReactContextError`, on clean dev too. That failure says nothing about the bump.

## 4. Ship

- Commit manifests and `bun.lock` together. Load `file-pr`. The body lists the bumps by group, answers the research questions only where the answer is not "nothing", names the follow-ups you left out, and says `Supersedes #a, #b`. Label it `dependencies`.
- Load `babysit`. Dev requires `validate`, `app-surfaces`, `Analyze (actions)` and `Analyze (javascript-typescript)`, and requires the branch to be up to date with dev, so rebase when dev moves. CodeRabbit posts a skip notice instead of a review here, so do not wait on it.
- `gh pr merge <n> --squash`.
- Close each Dependabot PR: `gh pr comment <n> --body-file <file>` naming the merged PR, then `gh pr close <n>`. Dependabot closes some of them itself once the merge lands.
- Watch every run for the merge commit: `gh api "repos/beeblastco/broods/actions/runs?head_sha=<sha>"`. `CI`, `Deploy`, `Deploy Convex`, the `Build * Image` workflows, and the `Dashboard e2e` that follows the dashboard image all have to finish green.
- Promote with `gh workflow run promote.yaml`. It waits for dev's required checks, fast-forwards main, dispatches `deploy-convex.yaml`, then deploy, the images, docs and npm publish in parallel. Watch the promote run to the end; it fails if any dispatched run fails.

Never deploy by hand. Production changes only through the promote workflow.
