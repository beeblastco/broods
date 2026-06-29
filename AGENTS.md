# broods Monorepo Guide

This is a Bun workspaces monorepo for Broods / broods.

## Workspace Map

- `apps/core` (`@broods/core`): SST app for the serverless agent harness on AWS Lambda. It owns account management, agent execution, channel webhooks, tools, skills, sandboxes, workspaces, async/status flows, SSE, and deployment. Read `apps/core/AGENTS.md` before changing it.
- `apps/dashboard` (`@broods/dashboard`): Next.js 16 dashboard UI for operating the core application through the shared Convex backend. Read `apps/dashboard/AGENTS.md` before changing it.
- `apps/docs` (`@broods/docs`): Docusaurus docs for the core, public API, and whole application architecture. Update it when core behavior, public config, API shape, diagrams, or workflows change.
- `packages/convex` (`@broods/convex`): shared Convex backend used by the dashboard and read by core in production. Read `packages/convex/AGENTS.md` before changing Convex schema, functions, auth, or generated files.
- `packages/broods` (`broods`): CLI + TypeScript client SDK package. This is not finished yet; the CLI is currently a scaffold and the SDK is a thin HTTP/SSE client.
- `packages/demos`: runnable demo folders using the SDK against a deployed core API. This is not a workspace package; keep demos aligned with public API/config changes.

## How To Work Here

- Install dependencies only from the repo root with `bun install`.
- Use Bun, not npm/yarn/pnpm.
- Declare dependencies in the package that imports them; the workspace uses Bun's isolated linker.
- Keep env files package-local. Do not commit real secrets.
- For unknown JSON/config/webhook payloads, prefer a clearly named `isPlainObject` guard at the nearest package boundary. Do not add new `isRecord` helpers; consolidate repeated object guards into the package's existing utility/helper module instead of copying them into each file. Use schema validators for complex external payloads.
- Run focused checks from the root when possible:
  - `bun run check` for core + Convex + SDK type checks.
  - `bun run test` for core tests.
  - `bun run build` for core Lambda builds.
  - `bun run dashboard` / `bun run dashboard:build` for the dashboard.
  - `bun run docs` / `bun run docs:build` for docs.
- Do not deploy unless explicitly asked to do it locally. `bun run deploy` targets `apps/core`; use `dev` only when a stage is needed. Always push to the `dev` branch and let CI/CD handle deployment. `main` is branch-protected and only receives fast-forward merges from `dev` via the "Promote dev to main" workflow (Actions tab, one click), which triggers the production deploys.
- Keep changes scoped to the workspace you are touching, but update linked docs, examples, generated Convex files, and tests when behavior or public contracts change.

## Cross-Workspace Notes

- Core is the source of truth for runtime behavior.
- Dashboard is the user interface for configuring and operating the core application. It imports Convex via `@broods/convex/...`, not a local `convex/` folder.
- Docs explain both the core and the full application architecture. Prefer focused updates in the right doc, and update Mermaid diagrams when architecture changes.
- Convex `_generated/` is committed on purpose. After schema/function changes, run `bun run --filter @broods/convex codegen` and commit generated diffs.
- React versions are aligned per app package. Do not add React to the root package.
- When public API or config shape changes, sync `apps/docs/docs/api-reference/openapi.yaml`, relevant docs, demos, SDK types/client code, and focused tests.
