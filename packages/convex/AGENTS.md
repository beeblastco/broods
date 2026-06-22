# packages/convex Agent Guide

Scope: this file applies to `packages/convex` (`@broods/convex`), the shared Convex backend used by the dashboard and read by core in production.

If you started directly in this folder, also read `../../AGENTS.md` for the monorepo-wide rules. Before changing Convex schema or functions, read `README.md` and `_generated/ai/guidelines.md`; the generated guidelines override model training data for Convex APIs and patterns.

## Package Context

- `../../apps/dashboard` deploys this package as its Convex project and imports functions through `@broods/convex/_generated/api`.
- `../../apps/core` does not deploy these functions. Its storage adapter calls internal functions remotely through `ConvexHttpClient` with a Convex deploy key.
- Sensitive agent config and sandbox credentials are encrypted before storage. The dashboard must not read those plaintext secrets. Two deliberate exceptions, both owner-gated: (1) environment variables — revealed on demand via `environmentVariables.reveal` (dashboard eye-icon) or the CLI `env get`, each reveal writing an `environmentVariableReveals` audit row; (2) the environment runtime API key (`fp_agent_…`) — stored AES-GCM encrypted on `agentDeployments` (`apiKeyCiphertext/Iv/Tag`) and recovered via the `agentDeployments.revealKeyForEnvironment` query (dashboard streaming) or the CLI `runtime-key` route (`broods login`), so the owner can reconnect without rotating (no audit row — unlike env vars). Agent config and sandbox credentials stay non-readable.
- The Convex CLI runs from this directory and reads `CONVEX_DEPLOYMENT` from `.env.local`.

## Workflow

- Do not run `bun convex dev` unless explicitly asked; a Convex dev server is usually already running.
- After schema or function changes, run `bun run --filter @broods/convex codegen` from the repo root, or `bunx convex codegen` from this directory.
- Commit `_generated/` diffs. Generated Convex files are committed on purpose so core and dashboard typecheck without a local codegen step.
- Deploys happen through the dashboard image build (`convex deploy`); this package is not deployed standalone unless explicitly requested.

## Authentication

WorkOS AuthKit handles SSO with Google OAuth. The `users` table is synced from WorkOS webhooks:

- `auth.ts`: AuthKit instance and webhook event handlers (`user.created`, `user.updated`, `user.deleted`)
- `auth.config.ts`: JWT provider config for WorkOS token validation
- `user.ts`: Public API (`getCurrent`, `updateProfile`, `requestAccountDeletion`)

All authenticated public Convex functions use `authKit.getAuthUser(ctx)` for access control.

Each public API that needs an authenticated user must include this block, with the comment:

```typescript
// Check authenticated user
const user = await authKit.getAuthUser(ctx);
if (!user) {
  throw new Error("User not found or not authenticated");
}
```

## Docstrings

Add JSDoc to all functions and types. Keep it to 1-2 sentences focused on what the code does and why.

```typescript
/**
 * Brief description of purpose.
 * @param name description
 * @returns description
 * @throws description
 */
```

Do not put `-` between the parameter name and description. Update docstrings when modifying functions.

## Code Style

- Use `key: value` object syntax instead of shorthand.
- Keep code simple and readable. Do not add abstractions unless they remove real duplication or complexity.
- Each return clause should have one blank line before the `return` statement.
- Do not create a new function unless the behavior is meaningfully different from existing reusable code.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
