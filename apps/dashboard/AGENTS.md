<!-- BEGIN:nextjs-agent-rules -->

# Next.js: ALWAYS read docs before coding

Before any Next.js work, find and read the relevant doc in `node_modules/next/dist/docs/`. Your training data is outdated — the docs are the source of truth.

<!-- END:nextjs-agent-rules -->

# apps/dashboard

`@broods/dashboard` — Next.js UI. operate core through the shared Convex backend. paths relative to `apps/dashboard/`.

## Gotchas

- no local `convex/` folder here. the backend is `@broods/convex` (`../../packages/convex`), imported as `@broods/convex/_generated/api` and friends. never make a local one.
- session middleware is `proxy.ts`, **not** `middleware.ts` ([docs](https://nextjs.org/docs/app/api-reference/file-conventions/proxy)).
- everything lives under `app/` — components, hooks and client lib too (`app/components/`, `app/hooks/`, `app/lib/`). there is no top-level `components/` or `lib/`.
- `app/components/ui/` is shadcn. skip it, do not edit it.
- `app/lib/agentConfigCodec.ts` is a mirror. the Convex-side codec is the boss — move that one first, then match here.
- `app/lib/coreEndpoint.ts` own how the browser reach core through the gateway. do not scatter base-url logic anywhere else.
- WorkOS AuthKit do SSO. dashboard own `proxy.ts` and `app/auth/`. user sync, JWT provider config and access control inside Convex functions are **not** here, they live in `../../packages/convex`.
- the Dockerfile image build re-run `convex deploy`. a dashboard deploy is also a Convex deploy.

## UI Rules

- no sonner, no toast, no transient popup library. feedback and state must show in the main component, where user can touch it.
- no custom `gap`, `margin`, `padding`. shadcn/ui already ship theme and spacing. use the default. custom spacing only when user ask.
- every interactive thing need an explicit cursor class. clickable button / link / trigger → `cursor-pointer`, disabled → `cursor-not-allowed`. plain `<button>` and `<a>` fall back to `cursor-default` in some resets, so always set it. same for shadcn/ui overrides.
- component file name is CamelCase.
