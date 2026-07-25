# packages/convex

`@broods/convex` — shared Convex backend and config plane. dashboard deploy it, core read it. paths relative to `packages/convex/`.

read `_generated/ai/guidelines.md` before you touch schema or functions. it beat model training data on Convex API and pattern — trust it, not memory. Convex skills sit in `.claude/skills/`; grab `convex-migration-helper` for any breaking schema change, backfill or table reshape.

## Gotchas

- `configHttp.ts` is **the config plane**, not a side road. account metadata/rotate and agent, skills, tools, workspace-files, cron, workspace, sandbox-config, policy CRUD all live here, because core does not own them. gateway route those paths in by `BROODS_CONFIG_URL`.
- `../../apps/core` does **not** deploy these functions. it call internal functions remote through `ConvexHttpClient` with a deploy key, and reach the generated API by `require()`. so an internal function signature change break core silently at runtime, not at core typecheck.
- `model/` is the pure half — no Convex ctx, unit-testable. rules, codecs, ownership and sync logic go there. anything needing ctx stay in the top-level file. keep the split, it is the only reason this package is testable.
- deploy only happen through the dashboard image build (`convex deploy`). no standalone deploy unless user ask.
- Convex CLI run from this folder and read `CONVEX_DEPLOYMENT` from `.env.local`. do not run `bun convex dev` unless user ask — a dev server is usually already up.

## Secrets

agent config and sandbox credential are encrypted before storage and the dashboard must never read that plaintext. two holes on purpose, both owner-gated:

1. **env vars** — reveal by `environmentVariables.reveal` (dashboard eye-icon) or CLI `env get`. every reveal write an `environmentVariableReveals` audit row.
2. **environment runtime API key** (`fp_agent_…`) — AES-GCM encrypted on `agentDeployments` (`apiKeyCiphertext` / `Iv` / `Tag`), recovered by `agentDeployments.revealKeyForEnvironment` or the CLI `runtime-key` route, so an owner reconnect without rotating. no audit row here, unlike env vars.

agent config and sandbox credential stay unreadable. keep it that way.

## Auth

WorkOS AuthKit do SSO with Google OAuth. `users` table sync from WorkOS webhooks in `auth.ts`; delete cascade in `workosUserDeletion.ts`.

every authenticated public function use `authKit.getAuthUser(ctx)`. public API that need a user must carry this block, comment included:

```typescript
// Check authenticated user
const user = await authKit.getAuthUser(ctx);
if (!user) {
  throw new Error("User not found or not authenticated");
}
```

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
