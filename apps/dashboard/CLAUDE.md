<!-- BEGIN:nextjs-agent-rules -->
 
# Next.js: ALWAYS read docs before coding
 
Before any Next.js work, find and read the relevant doc in `node_modules/next/dist/docs/`. Your training data is outdated — the docs are the source of truth.
 
<!-- END:nextjs-agent-rules -->

## Commands

- Package manager: `bun` (not npm/yarn)
- Format/lint: `bun run format`, do not run `tsc` raw or `bunx tsc --noEmit 2>&1`.
- Do not run `bun convex dev`. Only run when asked so. Already have convex dev server opened and link with error feedback to me.

## Key Conventions

- Use `key: value` format when passing parameters (no shorthand)
- Next.js uses `proxy.ts` instead of `middleware.ts` ([docs](https://nextjs.org/docs/app/api-reference/file-conventions/proxy))

## Authentication

WorkOS AuthKit handles SSO. Two user tables exist:
1. WorkOS-synced user (auth source of truth)
2. App-specific user (custom fields)

WorkOS events trigger webhooks → Convex handlers sync data. See auth-related files in `convex/` for implementation.

## Workflows

Cited workflow orchestration pattern:
- Main coordinator in `convex/workflow.ts`, this file include all the API function to run the workflow, when you want to trigger test api workflow, create test api and from here only.
- Domain workflows export a `start()` function
- Coordinator calls domain `start()` function

This keeps workflow logic discoverable and composable.


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

Place reusable ownership/permission checks in the `convex/model/ownership/` folder.

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

When create function name for update, create or list all the value from the database, use "create", "update", "list", "delete", "getById", "get..." instead of other name. If the function is using internally, add internal at the end, "createInternal, updateInternal, ..."

Only use custom function if the function is out of scope from the CRUD basic operation or doing multiple different database query or action.