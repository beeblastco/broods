<!-- BEGIN:nextjs-agent-rules -->

# Next.js: ALWAYS read docs before coding

Before any Next.js work, find and read the relevant doc in `node_modules/next/dist/docs/`. Your training data is outdated — the docs are the source of truth.

<!-- END:nextjs-agent-rules -->

## Monorepo context

This app is `apps/dashboard` in the broods Bun-workspaces monorepo. If you started directly in this folder, also read `../../AGENTS.md` for the monorepo-wide rules.

The Convex backend lives at `../../packages/convex` (`@broods/convex`) and is imported here as `@broods/convex/...` (for example `@broods/convex/_generated/api`), never via a local `convex/` directory.

Before changing any Convex backend file under `../../packages/convex`, read `../../packages/convex/AGENTS.md`. That file owns Convex schema, function, auth, codegen, and backend style rules.

## Commands

- Package manager: `bun` (not npm/yarn)
- Format/lint: `bun run format`, do not run `tsc` raw or `bunx tsc --noEmit 2>&1`.

## Key Conventions

- Use `key: value` format when passing parameters (no shorthand)
- Next.js uses `proxy.ts` instead of `middleware.ts` ([docs](https://nextjs.org/docs/app/api-reference/file-conventions/proxy))

## Authentication

WorkOS AuthKit handles SSO with Google OAuth. Dashboard-owned auth code lives in:

- `proxy.ts` — Next.js session middleware
- `app/auth/` — sign-in/callback routes using `@workos-inc/authkit-nextjs`

Convex user sync, JWT config, and authenticated Convex functions are backend concerns. Read `../../packages/convex/AGENTS.md` before changing them.

- Ignore or skip `components/ui/` (Shadcn components)
- Component files use CamelCase naming

Do not create new function unless it is completely different from and cannot reusable code in any way. Try to figure it out a way to write less code but still maintainable. Remember the larger the code base and more complex -> the more technical debt.

- Each return clause have to seperate 1 line before the return statement.

Do not use sonner, toast, or any transient popup notification library. Feedback and state must be visible and interactive through the main components themselves.

Do not add custom `gap`, `margin`, or `padding`. shadcn/ui already ships its own theme and spacing — use the defaults, and only reach for custom spacing when explicitly asked.

UI/UX cursor rules — every interactive element must have an explicit cursor class:

- Clickable buttons, links, triggers → `cursor-pointer`
- Disabled elements → `cursor-not-allowed`
- Plain `<button>` and `<a>` elements default to `cursor-default` in some resets, so always set it explicitly.
- Apply this to all custom components and any shadcn/ui component overrides in `components/ui/`.
