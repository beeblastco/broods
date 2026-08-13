# Guide

Bun workspaces monorepo. this file = rules for whole repo. each workspace have own `AGENTS.md` with its own gotcha. read that one when you touch that folder, ignore rest.

## Workspaces

- `apps/core` (`@broods/core`) — agent harness. one Bun container behind gateway. owns accounts, agent runs, channel webhooks, tools, skills, sandboxes, workspaces, async/status, SSE, deploy.
- `apps/lambda` — two plain `.mjs` files: the AWS Lambda that runs account-uploaded custom tools needing node/npm. no build, not a workspace; `apps/core/sst.config.ts` deploys it.
- `apps/gateway` (`@broods/gateway`) — the front door. every public request hit this first. splits config-plane paths from core paths, and terminates the agent / observability / terminal WebSockets.
- `apps/dashboard` (`@broods/dashboard`) — Next.js UI. drives core through Convex.
- `packages/convex` (`@broods/convex`) — shared Convex backend for both dashboard and core + config plane.
- `apps/docs` (`@broods/docs`) — Docusaurus docs. core, public API, whole architecture.
- `packages/broods` (`broods`) — published CLI + TS SDK. `broods dev` / `deploy` sync a local `broods/` project to a stage, like `convex dev`. also login, env, logs, stream, agent, run.
- `packages/demos` — runnable demos on SDK against deployed core. not a workspace package.

they are one product, not seven islands. gateway is the door, core own runtime truth, convex own config + persistence, dashboard and CLI are two faces on the same config plane, docs and demos describe it. touch a public contract in one, walk the others.

outside repo, sibling of checkout:

- `../infra` — k8s cluster + VM provision. keep `apps/core/sst.config.ts` constants, naming, tags aligned with it.
- `../lambda-sanbdox` — Rust HTTP server baked into an AWS Lambda **MicroVM** image (Firecracker), runs bash/python/node in the sandbox. not a Lambda custom runtime anymore, that model is dead. backs `apps/core` `microvm-executor.ts`, where provider string is still `"lambda"`.

## How To Work Here

- repo using workspace feature from [bun](https://bun.com/docs/pm/workspaces).
- read `package.json` for scripts command to run in workspace.
- prefer strict type. do not reach for `isPlainObject` or `isRecord` on new code. find the real type first, or the library that already ship it. write your own type or interface when none fit. runtime guard only when the typing get too complex or too long to be worth it — when you hit that, say so to user and let them decide.
- breaking storage or backend cutover: no compat shim for dead record format or old id unless user ask. clean reset and recreate account/resource instead. never delete live data, never deploy, without user say so.
- do not deploy unless user ask. push to `dev`, let CI/CD do it. `main` is protected, only fast-forward from `dev` by "Promote dev to main" workflow (Actions tab, one click), that triggers prod deploy.
- `.github/workflows/drift-cleanup.yaml` run `sst refresh` + `sst diff` nightly and delete Pulumi-tracked orphan per stage. stand up a new stage = add it to that matrix or drift eat it.
- keep change inside workspace you touch. but public contract move = also move `apps/docs/docs/api-reference/openapi.yaml`, the docs, `packages/demos`, SDK types/client in `packages/broods`, and the focused tests.
- Convex schema or function change = `bun run --filter @broods/convex codegen`, commit the generated diff. it is committed on purpose so core and dashboard typecheck with no local codegen.
- React version pinned per app package. never add React to root package.

## Code Style

every workspace. follow strict. workspace guide add to this, never replace.

- file order: constants, types, interfaces first. then exports and main logic. then private helpers used only in that file.
- same kind of function sit together — all async in one run, then all plain. alphabetical inside group so eye find fast.
- comment only key section. two lines max. no per-function docstring by default. if you need paragraph-long comment to say why workaround ok, code is wrong. fix code.
- `key: value` object syntax. no shorthand.
- one blank line before every `return`.
- no new function unless behavior really different from code that already exist. less code that stay maintainable is win. big complex code base = big technical debt.
- look for existing interface first. many come straight from Vercel AI SDK or other library. do not make new type when library type fit. but do not force reuse either.
- before say done: run package own `bun run check` (lint + types) and `bun run format` (prettier). never run raw `tsc` or `bunx tsc --noEmit`, wrong config.
- Put explicitly return type in each function, avoid using satisfies.
