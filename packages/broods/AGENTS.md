# packages/broods

`broods` — the published CLI + TS SDK. paths relative to `packages/broods/`.

## Gotchas

- **you do not hand-edit `version`.** `.github/workflows/bump-sdk-version.yaml` runs on every `dev` push that touches this package: `scripts/next-version.ts` derives the next version from the conventional-commit subjects since the last bump (`!` or `BREAKING CHANGE` → minor while `0.x`, `feat:` → minor, anything else → patch), verifies the package builds at it, then commits `chore(sdk): release broods X.Y.Z` back to `dev`. so **write real conventional subjects** — the subject line is the release note and the version.
- **the version lives in two files.** root `bun.lock` caches the workspace `version` alongside `package.json`, and `bun install --frozen-lockfile` fails if they disagree. `next-version.ts --write` patches both; if you ever bump by hand, move both.
- `scripts/next-version.ts` finds the last release by walking `package.json` history for a commit where the `version` value actually changed — dependency bumps touch the file without releasing, so "last commit to the file" would be wrong.
- **nothing publishes from `dev`.** `publish-npm.yaml` is main-only and is dispatched last by "Promote dev to main". it skips the publish if the version is already on npm, so a promote with no bump is a no-op. that is why an unbumped feature sat unpublished through `0.5.2`.
- **`dist/` is gitignored, and the bump bot's push does not fire `on: push`.** so a stale local build silently runs an old CLI, and the release commit itself skips CI (the bump workflow already gated it). run `bun run build` before trusting a local demo run.
- `tsconfig.json` only includes `src/**/*.ts`, so `bun run check` does **not** typecheck `scripts/`. run those scripts to prove them.
- the 31 demos under `packages/demos/*` link `broods` as `file:../../broods`; `harness-codex` is the one that pins a registry range, so it only sees features that are actually published.
