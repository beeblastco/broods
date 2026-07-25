<!-- BEGIN:nextjs-agent-rules -->

# Next.js: ALWAYS read docs before coding

Before any Next.js work, find and read the relevant doc in `node_modules/next/dist/docs/`. Your training data is outdated — the docs are the source of truth.

<!-- END:nextjs-agent-rules -->

# apps/dashboard

`@broods/dashboard` — Next.js UI on the shared Convex backend.

- session middleware is `proxy.ts`, **not** `middleware.ts` ([docs](https://nextjs.org/docs/app/api-reference/file-conventions/proxy)).
- component file name is CamelCase.
- no sonner, no toast, no transient popup library. feedback and state must show in the main component, where user can touch it.
- no custom `gap`, `margin`, `padding`. shadcn/ui already ship theme and spacing. use the default. custom spacing only when user ask.
- every interactive thing need an explicit cursor class. clickable button / link / trigger → `cursor-pointer`, disabled → `cursor-not-allowed`. plain `<button>` and `<a>` fall back to `cursor-default` in some resets, so always set it. same for shadcn/ui overrides in `app/components/ui/`.
