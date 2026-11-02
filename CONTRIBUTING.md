# Contributing

## Quick start

```bash
bun install              # install all workspaces (root only)
cp apps/core/.env.example apps/core/.env
# edit apps/core/.env and set AWS_ACCOUNT_ID, PROJECT_NAME, PROJECT_OWNER_EMAIL
```

- Run `sst` commands from `apps/core/`.
- Do not run `bun convex dev` unless explicitly asked; a dev server is usually already running.

## Development workflow

```bash
bun run check            # type-aware oxlint, oxfmt check, and every workspace check (dashboard adds @shadcn/lint)
bun run test             # every workspace's unit tests, scripts and benchmark gates
bun run build            # build the core Bun container binary
bun run verification:test # TypeScript contracts mirrored by the Lean models
(cd verification && lake build) # machine-check those models
# Try a demo (from repo root):
cd packages/demos/basic-stream && bun run start
```

- Dashboard: `bun run format` for formatting.
- Docs: `bun run docs` to preview locally.
- macOS desktop integration: `bun run --filter broods test:desktop` captures the screen and moves the pointer. It requires Screen Recording and Accessibility permissions, and stays out of the default unit suite.
- Do not deploy locally (`bun run deploy`) unless explicitly asked. Merge to `dev` and let CI/CD deploy. `main` is protected and only moves through the "Promote dev to main" workflow.

- Use Bun, not npm, yarn, or pnpm.
- Install dependencies only from the repo root.
- Declare every dependency a package imports in that package's `package.json` (Bun isolated linker).

## Before you change something

- Open an issue first to align on the approach.
- Read the root `AGENTS.md` for the repo-wide rules, then the workspace's own `AGENTS.md` if it has one. Only workspaces with their own gotchas carry a guide; the rest are covered by the root file. Today that is:
  - `apps/core/AGENTS.md`: Bun container runtime, request flow, tools, channels, sandboxes, SST
  - `apps/gateway/AGENTS.md`: front-door routing, config/core split, WebSocket surfaces
  - `apps/discord-forwarder/AGENTS.md`: Discord Gateway sockets
  - `apps/matrix-forwarder/AGENTS.md`: Matrix long-polls and E2EE keys
  - `apps/dashboard/AGENTS.md`: Next.js dashboard, routes and components, WorkOS auth
  - `packages/convex/AGENTS.md`: Convex schema, config plane, secrets, auth
  - `packages/broods/AGENTS.md`: published CLI + SDK, release versioning

## Code conventions

- **TypeScript + ESM.** Apps run their TypeScript directly on Bun; `packages/broods` builds to `dist/` for npm.
- **Comments.** Default to none. Write one only for a constraint, an external quirk, or an invariant the code can't show: one line where you can, four at most. Don't restate names, narrate steps, or record history (the PR carries that), and skip the file-header docstring unless the path and exports leave the file's role unclear.
- `broods/no-low-value-comments` lints comments, and CI holds them to 2.5% of JS/TS lines (4% per workspace) with `bun run comments:check`. The full rule is in the root `AGENTS.md`.
- Use `key: value` object syntax instead of shorthand.
- Put one blank line before a function's final `return`.
- Prefer reusing existing interfaces from the Vercel AI SDK or other libraries rather than creating new ones.
- Keep code simple and readable. Avoid unnecessary abstraction.

## Adding features

- **New channel.** Create `apps/core/src/shared/<channel>-channel.ts` implementing `ChannelAdapter`, then wire it into `apps/core/src/harness/integrations.ts`. Keep channel-specific logic inside the channel module.
- **New tool.** Create `apps/core/src/harness/tools/<name>.tool.ts`, export a default factory, and register it in `apps/core/src/harness/tools/index.ts`. Add validation in `packages/convex/model/agentRules.ts` if the tool accepts `config.tools.<name>` options.
- **New command.** Add an entry to `apps/core/src/shared/commands.ts`.

## Cross-workspace rules

- Core is the source of truth for runtime behavior.
- When public API or config shape changes, sync the OpenAPI spec (`apps/docs/docs/api-reference/openapi.yaml`), relevant docs, demos, and SDK types.
- Convex `_generated/` is committed on purpose. After schema changes, run `bun run --filter @broods/convex codegen` and commit the diff.
- Update docs and diagrams when architecture or behavior changes. Keep docs focused. Don't add the same explanation to every file.

## Security

- Do not commit real secrets. `.env` files stay package-local. gitleaks scans staged files in the pre-commit hook (`brew install gitleaks`) and every PR in CI.
- Report vulnerabilities privately, see [SECURITY.md](SECURITY.md). Do not open a public issue.

## CI

`.github/workflows/ci.yaml` runs `check`, `test`, and `build` on every PR, including docs-only changes. It also checks dependency advisories and performance budgets, builds the dashboard, and runs its browser fixtures. The docs build runs when docs or dependencies change.

## Community

- Chat with maintainers on [Discord](https://discord.gg/beeblast).
- File bugs and feature requests in [GitHub Issues](https://github.com/beeblastco/broods/issues).
