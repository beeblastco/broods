# packages/convex

`@broods/convex` — shared Convex backend and config plane. dashboard deploy it, core read it.

Convex skills sit in `.claude/skills/`; grab `convex-migration-helper` for any breaking schema change, backfill or table reshape.

## Auth

WorkOS AuthKit do SSO with Google OAuth. `users` table sync from WorkOS webhooks in `auth.ts`.

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
