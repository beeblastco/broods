# packages/convex

`@broods/convex` is the shared Convex backend and config plane. dashboard deploy it, core read it.

Convex skills sit in `.claude/skills/`; grab `convex-migration-helper` for any breaking schema change, backfill or table reshape.

## Gotchas

- **`args`/`returns` validators are runtime-only. `bun run check` cannot see them.** widening a TS type that a validator also describe pass typecheck, pass tests, then 500 in production the first time the function run. adding a CLI manifest resource kind mean four places, not one: `cli/types.ts`, `resourceValidator`, `idsValidator`, and the sync itself. an extra key on a returned object is rejected just as hard as a missing one.

## Auth

WorkOS AuthKit do SSO with Google OAuth. `users` table sync from WorkOS webhooks in `auth.ts`.

`BROODS_AUTH_PROVIDER` pick the sign-in and every deployment set it (`workos` on dev and prod, `deploy-convex.yaml` set it before each deploy; `self-host` on a local stack). self-hosted: `auth.config.ts` trust only the dashboard's admin-key session (`model/selfHostAuth.ts`, `BROODS_SESSION_JWKS`), never WorkOS, and `user.ensureSynced` seed the admin into the AuthKit component's users table, so `authKit.getAuthUser` work the same. the deploy evaluate `auth.config.ts` on the backend and refuse it when it read any unset variable, and there is no way to probe for one, so each branch read only its own variables and `tests/authConfig.test.ts` evaluate both branches the way the backend do. a new variable in `auth.config.ts` = add it to that test's env set, or the deploy fail.

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
