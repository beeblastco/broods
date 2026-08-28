# packages/broods

`broods` — the published CLI + TS SDK. paths relative to `packages/broods/`.

## Gotchas

- **you do not hand-edit `version`, and nothing commits it either.** `publish-npm.yaml` derives the version at publish time: `scripts/next-version.ts --write` reads the conventional-commit subjects since the last release (`!` or `BREAKING CHANGE` → minor while `0.x`, `feat:` → minor, anything else → patch) and applies it to the runner's checkout only. so **write real conventional subjects** — the subject line is the release note and the version.
- **the version lives in two files.** root `bun.lock` caches the workspace `version` alongside `package.json`, and `bun install --frozen-lockfile` fails if they disagree. `next-version.ts --write` patches both; if you ever bump by hand, move both.
- **`package.json`'s `version` is not the released version.** since no bump is committed back, the file holds whatever the last hand-edit left; `scripts/next-version.ts` anchors on the newest `broods-v*` tag instead, which is what `publish-npm.yaml` cuts on the commit it published. that is the only record of what shipped.
- **the bump used to be a commit pushed to `dev`, and cannot be again.** `dev` requires four status checks, a direct push carries none, so the push is refused (`GH006`) and dropping the `[skip ci]` marker does not help: the push is rejected before any workflow could run on that commit.
- **nothing publishes from `dev`.** `publish-npm.yaml` is main-only and is dispatched last by "Promote dev to main". it skips the publish when nothing since the last tag touched this package, and again if the derived version is already on npm, so a promote with no releasable change is a no-op. that is why an unbumped feature sat unpublished through `0.5.2`.
- **`dist/` is gitignored.** a stale local build silently runs an old CLI. run `bun run build` before trusting a local demo run.
- **the CLI has to run on plain `node`, not only bun.** node erases type syntax and nothing else, so `manifest.ts` registers an esbuild load hook before importing a project's `broods/*.ts`. bun ships no `module.registerHooks`, so a `bun test` never touches that path — `tests/node-runtime.test.ts` spawns a real `node` child instead. keep `manifest.ts` and everything it imports free of non-erasable syntax (`enum`, decorators, parameter properties) or that test cannot even load it.
- `tsconfig.json` only includes `src/**/*.ts`, so `bun run check` does **not** typecheck `scripts/`. run those scripts to prove them.
- the 31 demos under `packages/demos/*` link `broods` as `file:../../broods`; `harness-codex` is the one that pins a registry range, so it only sees features that are actually published.
