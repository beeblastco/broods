# broods Monorepo Guide

Bun workspaces monorepo. this file = rules for whole repo. each workspace have own `AGENTS.md` with the detail. read that one when you touch that folder, ignore rest.

## Workspaces

- `apps/core` (`@broods/core`) — agent harness. one Bun container behind gateway. owns accounts, agent runs, channel webhooks, tools, skills, sandboxes, workspaces, async/status, SSE, deploy. detail in `apps/core/AGENTS.md`.
- `apps/dashboard` (`@broods/dashboard`) — Next.js 16 UI. drives core through Convex. detail in `apps/dashboard/AGENTS.md`.
- `packages/convex` (`@broods/convex`) — shared Convex backend + config plane. dashboard deploys it, core reads it in prod. detail in `packages/convex/AGENTS.md`.
- `apps/docs` (`@broods/docs`) — Docusaurus docs. core, public API, whole architecture.
- `packages/broods` (`broods`) — CLI + TS SDK. not finished. CLI is scaffold, SDK is thin HTTP/SSE client.
- `packages/demos` — runnable demos on SDK against deployed core. not a workspace package.

outside repo, sibling of checkout:

- `../infra` — k8s cluster + VM provision. keep `apps/core/sst.config.ts` constants, naming, tags aligned with it.
- `../lambda-sanbdox` — custom Lambda runtime for sandbox. runs bash, node, python. pretends to be VM.

## Landmarks

- `CONTRIBUTING.md` — human contribution flow, branch policy, PR.
- root `package.json` — the `bun run` scripts, workspace globs.
- `.github/workflows/` — CI/CD. `drift-cleanup.yaml` runs `sst refresh` + `sst diff` nightly, kills Pulumi-tracked orphans per stage. prod needs GitHub `production` approval. new stage = add to its matrix.
- `apps/docs/docs/api-reference/openapi.yaml` — public API contract. change request/response shape, change this too.
- `packages/convex/_generated/` — committed on purpose. core and dashboard typecheck without local codegen.

## How To Work Here

- install only from repo root: `bun install`. Bun only, no npm/yarn/pnpm.
- package that imports dep declares dep. Bun isolated linker.
- env files stay package-local. never commit real secret. new env read = update matching `.env.example`.
- breaking storage or backend cutover: no compat shim for dead record format or old id unless user ask. clean reset and recreate account/resource instead. never delete live data, never deploy, without user say so.
- unknown JSON/config/webhook payload: use named `isPlainObject` guard at nearest package boundary. no new `isRecord` helper. repeated guard go in package existing util file, not copy-paste in every file. complex external payload = schema validator.
- checks from root:
  - `bun run check` — core + Convex + SDK types.
  - `bun run test` — core tests.
  - `bun run build` — core container build.
  - `bun run dashboard` / `bun run dashboard:build`.
  - `bun run docs` / `bun run docs:build`.
- do not deploy unless user ask. `bun run deploy` hits `apps/core`. push to `dev`, let CI/CD do it. `main` is protected, only fast-forward from `dev` by "Promote dev to main" workflow (Actions tab, one click), that triggers prod deploy.
- keep change inside workspace you touch. but when behavior or public contract move, move docs, examples, generated Convex files, tests too.

## Code Style

every workspace. follow strict. workspace guide add to this, never replace.

- file order: constants, types, interfaces first. then exports and main logic. then private helpers used only in that file.
- same kind of function sit together — all async in one run, then all plain. alphabetical inside group so eye find fast.
- comment only key section. two lines max. no per-function docstring by default.
- `key: value` object syntax. no shorthand.
- one blank line before every `return`.
- no new function unless behavior really different from code that already exist. less code that stay maintainable is win. big complex code base = big technical debt.
- look for existing interface first. many come straight from Vercel AI SDK or other library. do not make new type when library type fit. but do not force reuse either.
- complexity bad. no over-engineer feature, no over-engineer patch. simple, small, readable, easy to walk. abstraction only when it kill real duplication.
- before say done: run package own `bun run check` (lint + types) and `bun run format` (prettier). never run raw `tsc` or `bunx tsc --noEmit`, wrong config.

if you need paragraph-long comment to say why workaround ok, code is wrong. fix code.

## Cross-Workspace

- core is source of truth for runtime behavior.
- dashboard is the UI that configure and operate core. imports Convex as `@broods/convex/...`, never local `convex/` folder.
- convex is config plane and persistence both others talk to. schema change ripple: run `bun run --filter @broods/convex codegen`, commit generated diff.
- docs explain core and whole architecture. edit the right doc, not every doc. architecture move = Mermaid diagram move.
- React version aligned per app package. never add React to root package.
- public API or config shape change = also sync `apps/docs/docs/api-reference/openapi.yaml`, the docs, `packages/demos`, SDK types/client in `packages/broods`, and the focused tests.
