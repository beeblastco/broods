<!-- BEGIN:nextjs-agent-rules -->

# Next.js: ALWAYS read docs before coding

Before any Next.js work, find and read the relevant doc in `node_modules/next/dist/docs/`. Your training data is outdated — the docs are the source of truth.

<!-- END:nextjs-agent-rules -->

# apps/dashboard

`@broods/dashboard` — Next.js 16 UI. operate core through shared Convex backend. paths here relative to `apps/dashboard/`.

no local `convex/` folder here. backend is `@broods/convex` (`../../packages/convex`), imported as `@broods/convex/_generated/api` and friends.

## Map

routes, `app/`, App Router:

- `app/layout.tsx`, `app/globals.css` — root shell, Tailwind entry.
- `app/(main)/projects/` — project list. `app/(main)/[projectId]/` — per-project workspace, split `dashboard/`, `sandbox/`, `scheduler/`, `settings/`.
- `app/(main)/settings/account/`, `app/(main)/settings/org/` — account and org settings.
- `app/auth/sign-in/`, `app/auth/callback/` — WorkOS AuthKit routes.
- `app/cli-auth/start/` — device-code handoff for `broods login`.
- `app/healthz/` — container liveness probe.
- `proxy.ts` — session middleware. Next.js use `proxy.ts`, **not** `middleware.ts` ([docs](https://nextjs.org/docs/app/api-reference/file-conventions/proxy)).

components, `app/components/`:

- `canvas/` agent canvas, `node/` canvas nodes, `side-panel/` inspector, `header/`, `icons/`.
- `app/components/ui/` — shadcn primitives (`button.tsx`, `dialog.tsx`, `sheet.tsx`, `command.tsx`, …). **skip these, do not edit.** shadcn config in `components.json`.

hooks, `app/hooks/`:

- `useAgentChat.ts` — chat/stream surface against core.
- `useObservabilityStream.ts` — live run telemetry.
- `useAgentHealth.ts`, `useConnectedAgentConfig.ts`, `useEnvironment.ts`.

client logic, `app/lib/`:

- `coreEndpoint.ts` — how browser reach core through gateway.
- `agentConfigCodec.ts`, `agentConfigOptimistic.ts` — agent config encode/decode, optimistic update. Convex-side codec is the boss. keep these two aligned with it.
- `toolServiceOptimistic.ts`, `skillRefs.ts`, `skillsCredentials.ts`, `runtimeVariables.ts`, `canvasRuntimeRefs.ts`, `onboardingSecret.ts`, `pricing.ts`, `prefetch.ts`, `errors.ts`, `utils.ts`.

rest: `tests/`, `Dockerfile` (image build re-run `convex deploy`), `next.config.ts`, `eslint.config.mjs`, `skills-lock.json`.

## Commands

- `bun`, not npm/yarn.
- `bun run format` for prettier. never raw `tsc` or `bunx tsc --noEmit`.
- from repo root: `bun run dashboard`, `bun run dashboard:build`.

## Rules

- component file name is CamelCase.
- no sonner, no toast, no transient popup library. feedback and state must show in the main component, where user can touch it.
- no custom `gap`, `margin`, `padding`. shadcn/ui already ship theme and spacing. use default. custom spacing only when user ask.
- every interactive thing need explicit cursor class:
  - clickable button, link, trigger → `cursor-pointer`
  - disabled → `cursor-not-allowed`
  - plain `<button>` and `<a>` fall back to `cursor-default` in some resets, so always set it.
  - same for custom component and for any shadcn/ui override in `app/components/ui/`.

## Auth

WorkOS AuthKit do SSO with Google OAuth. dashboard side:

- `proxy.ts` — session middleware.
- `app/auth/` — sign-in and callback routes on `@workos-inc/authkit-nextjs`.

Convex user sync, JWT provider config, access control inside Convex functions = backend, live in `../../packages/convex`.
