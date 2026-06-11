<!-- BEGIN:nextjs-agent-rules -->

# Next.js: ALWAYS read docs before coding

Before any Next.js work, find and read the relevant doc in `node_modules/next/dist/docs/`. Your training data is outdated — the docs are the source of truth.

<!-- END:nextjs-agent-rules -->

## Monorepo context

This app is `apps/dashboard` in the filthy-panty Bun-workspaces monorepo (see the root `AGENTS.md` for workspace rules). The Convex backend lives at `packages/convex` (`@filthy-panty/convex`) — imported here as `@filthy-panty/convex/...` (e.g. `@filthy-panty/convex/_generated/api`), never via a local `convex/` directory. Run `bun install` at the repo root only; run convex CLI commands from `packages/convex/`.

## Commands

- Package manager: `bun` (not npm/yarn)
- Format/lint: `bun run format`, do not run `tsc` raw or `bunx tsc --noEmit 2>&1`.
- Do not run `bun convex dev`. Only run when asked so. Already have convex dev server opened and link with error feedback to me.

## Key Conventions

- Use `key: value` format when passing parameters (no shorthand)
- Next.js uses `proxy.ts` instead of `middleware.ts` ([docs](https://nextjs.org/docs/app/api-reference/file-conventions/proxy))

## Authentication

WorkOS AuthKit handles SSO with Google OAuth. The `users` table is synced from WorkOS webhooks:

- `packages/convex/auth.ts` — AuthKit instance and webhook event handlers (`user.created`, `user.updated`, `user.deleted`)
- `packages/convex/auth.config.ts` — JWT provider config for WorkOS token validation
- `packages/convex/user.ts` — Public API (`getCurrent`, `updateProfile`, `requestAccountDeletion`)
- `proxy.ts` — Next.js middleware for session management
- `app/auth/` — sign-in/callback routes using `@workos-inc/authkit-nextjs`

All authenticated Convex functions use `authKit.getAuthUser(ctx)` for access control.

## Args Handling

Always destructure args into const variables:

```typescript
export const myMutation = mutation({
  args: { userId: v.id("users"), name: v.string() },
  handler: async (ctx, args) => {
    const { userId, name } = args;
    // use userId, name
  },
});
```

## Ownership Checks

Place reusable ownership/permission checks in the `packages/convex/model/ownership/` folder.

## Function Calls

Always use explicit `key: value` format:

```typescript
// Good
await doSomething({ userId: userId, orgId: orgId });

// Bad - shorthand can introduce bugs
await doSomething({ userId, orgId });
```

Add JSDoc to all functions and types. Keep to 1-2 sentences. Focus on "what" and "why".

## Format

```typescript
/**
 * Brief description of purpose.
 * @param name description
 * @returns description
 * @throws description
 */
```

Do not put '-' between the name and the description.

## Rules for docstring

- Ignore or skip `components/ui/` (Shadcn components)
- React components: one-line description of what it displays
- Update docstrings when modifying functions
- Component files use CamelCase naming

Do not create new function unless it is completely different from and cannot reusable code in any way. Try to figure it out a way to write less code but still maintainable. Remember the larger the code base and more complex -> the more technical debt.

- Each return clause have to seperate 1 line before the return statement.
- Each public api that need authenticated user must include these line (must also have comments)

```typescript
// Check authenticated user
const user = await authKit.getAuthUser(ctx);
if (!user) {
  throw new Error("User not found or not authenticated");
}
```

When create function name for update, create or list all the value from the database, use "create", "update", "list", "remove", "getById", "get..." instead of other name. If the function is using internally, add internal at the end, "createInternal, updateInternal, ..."

Only use custom function if the function is out of scope from the CRUD basic operation or doing multiple different database query or action.

UI/UX cursor rules — every interactive element must have an explicit cursor class:

- Clickable buttons, links, triggers → `cursor-pointer`
- Disabled elements → `cursor-not-allowed`
- Plain `<button>` and `<a>` elements default to `cursor-default` in some resets, so always set it explicitly.
- Apply this to all custom components and any shadcn/ui component overrides in `components/ui/`.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`packages/convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
