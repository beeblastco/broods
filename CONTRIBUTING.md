# Contributing

Thanks for helping improve broods. Contributions are welcome — whether it's a bug fix, a new channel, a tool, or a docs improvement.

## Quick Start

```bash
bun install              # install all workspaces (root only)
cp apps/core/.env.example apps/core/.env
# edit apps/core/.env and set AWS_ACCOUNT_ID, PROJECT_NAME, PROJECT_OWNER_EMAIL
```

- Run `sst` commands from `apps/core/`.
- Do not run `bun convex dev` unless explicitly asked; a dev server is usually already running.

## Development Workflow

```bash
bun run check            # typecheck core + convex + SDK + demos
bun run test             # core unit tests (max-concurrency 1)
bun run build            # build the core Bun container binary
bun run demo stream.ts   # run a demo script (loads packages/demos/.env)
```

- Dashboard: `bun run format` for formatting.
- Docs: `bun run docs` to preview locally.
- Do not deploy locally (`bun run deploy`) unless explicitly asked — priority is pushing to `dev` or `main` and letting CI/CD handle deployment.

- Use **Bun** — not npm, yarn, or pnpm.
- Install dependencies only from the repo root.
- Declare every dependency a package imports in that package's `package.json` (Bun isolated linker).

## Before You Change Something

- Open an issue first to align on the approach.
- Read the workspace-specific `AGENTS.md` before editing files in that workspace:
  - `apps/core/AGENTS.md` — Bun container runtime, tools, channels, SST
  - `apps/dashboard/AGENTS.md` — Next.js dashboard, WorkOS auth
  - `packages/convex/AGENTS.md` — Convex schema, functions, auth
  - `AGENTS.md` (root) — monorepo-wide rules

## Code Conventions

- **TypeScript + ESM**, no transpile step.
- File header comments use a block docstring (`/** ... */`) with one blank line before the first import.
- Keep docstrings short — describe the file boundary, not a function inventory.
- Use `key: value` object syntax instead of shorthand.
- Each `return` statement should have one blank line before it.
- Prefer reusing existing interfaces from the Vercel AI SDK or other libraries rather than creating new ones.
- Keep code simple and readable. Avoid unnecessary abstraction.

## Adding Features

- **New channel** — create `apps/core/src/shared/<channel>-channel.ts` implementing `ChannelAdapter`, then wire it into `apps/core/src/harness/integrations.ts`. Keep channel-specific logic inside the channel module.
- **New tool** — create `apps/core/src/harness/tools/<name>.tool.ts`, export a default factory, register it in `apps/core/src/harness/tools/index.ts`, and add config validation in `apps/core/src/shared/domain/agent-config.ts`.
- **New command** — add an entry to `apps/core/src/shared/commands.ts`.

## Cross-Workspace Rules

- Core is the source of truth for runtime behavior.
- When public API or config shape changes, sync the OpenAPI spec (`apps/docs/docs/api-reference/openapi.yaml`), relevant docs, demos, and SDK types.
- Convex `_generated/` is committed on purpose. After schema changes, run `bun run --filter @broods/convex codegen` and commit the diff.
- Update docs and diagrams when architecture or behavior changes. Keep docs focused — don't add the same explanation to every file.

## Security

- Do not commit real secrets. `.env` files stay package-local.
- If you find a security vulnerability, please report it privately rather than opening a public issue.

## CI

`.github/workflows/ci.yaml` runs `check`, `test`, and `build` on every PR. Docs-only changes are skipped.

## Questions?

- [Discord](https://discord.gg/beeblast) — chat with maintainers
- [GitHub Issues](https://github.com/beeblastco/broods/issues) — bugs and feature requests
