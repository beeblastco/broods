<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Design lint

`bun run check` runs types, then `bun run lint`: oxlint with the root `.oxlintrc.json`, which loads [`@shadcn/lint`](https://github.com/shadcn-ui/lint) for this app. CI runs it in `ci.yaml` (app-surfaces) and `build-dashboard.yaml`. Every `shadcn/*` rule is an error, and each finding names the variant, size, or token to use instead.

- Colors come from tokens in `app/globals.css`, never the Tailwind palette. `success`, `warning`, `info`, `destructive`, `folder` and `run-*` switch between light and dark; `stage-*`, `canvas-*`, `usage-*`, `code-*`, `terminal-*` and `brand-*` read the same in both. A new color is a new `--color-*` token.
- Text below `text-xs` is `text-2xs` (11px) or `text-3xs` (10px). No arbitrary values: add a theme token instead.
- `style` carries only CSS custom properties that a class reads: `style={{ "--bar-width": `${pct}%` }}` with `w-(--bar-width)`. `global.d.ts` types them.
- Components own color, spacing and shape; use their props. Button `tone` (`muted`, `muted-destructive`, `destructive`); Button `variant="nav"` with `data-active` for header switchers; SidebarMenuButton and SidebarMenuSubButton `isActive` (sub button `variant="destructive"` for a Danger Zone tab) for sidebar sections and tabs; `variant="muted"` on Label, DropdownMenuLabel and ContextMenuLabel; Textarea `variant="code"`; DropdownMenuItem `data-active` for the current item.
- What a page may still set on a component (the `no-restyle` contracts): layout everywhere; typography on text components (Button, Input, Label, Badge, dialog and menu labels, select parts); `gap` on dialog and sheet titles; `pl` on Input for a leading icon; spacing on DialogContent, DialogHeader and TabsList; color and shape on Skeleton; anything on unstyled primitives (Collapsible parts, triggers, close buttons, ResizablePanel, TabsContent).
- `app/components/ui/**` styles its own internals, so `no-restyle`, `no-arbitrary-values` and `require-static-classes` are off there. `tests/**` may use inline styles. `nodrag` and `nopan` are allowed class names because React Flow reads them from the DOM.

# Taste

People keep this open all day and feel every dropped frame and every wait. A rule here that fights the task in front of you: say so and get the user's yes before breaking it.

Motion

- Only `opacity`, `translate` and `scale` move; colors and shadows may fade. Never width, height, an inset, margin, padding or `transition-all`: a layout transition relays out the canvas on every frame, about 3x the layout time. Use `transition` (Tailwind's default list has no layout property), `transition-colors`, or a named set. `tests/motion.test.ts` fails on a new one.
- Tokens and utilities live in `app/globals.css`: `duration-fast` (120 ms, hover, tooltips), `duration-base` (160 ms, menus, panels), `duration-slow` (200 ms, dialogs, sheets), `ease-snappy`; `motion-fade` (backdrops), `motion-pop` (Base UI popups), `motion-slide` (sheets), `motion-panel` (docked panels). The `ui` primitives already carry them. A timer that waits one out reads `MOTION_MS` (`app/lib/motion.ts`).
- Widths snap, content moves. The canvas side panel takes its column in one step and only its content fades in from the edge; on close it fades out over the canvas, inert, then hides; switching nodes replays nothing (`components/canvas/SidePanelSlot.tsx`, `hooks/usePresence.ts`).
- Nothing waits for motion: content renders in the same commit, input works during an enter, an exiting element is `inert`.
- Reduced motion: the guard at the end of `globals.css` zeroes every transition and animation. JS motion checks `prefersReducedMotion()`, as the canvas re-centre does.
- No continuously repainting animation (spinners on live streams, pulses, shimmer, animated edges), and no blur or `backdrop-filter` over content that moves.

Interaction

- Preload on intent: hover, focus and pointer down warm the next route and its tab's chunk (`useRouteIntent`, `app/hooks/useRouteIntent.ts`; `warmTestTab` in `NodeSidePanel.tsx` for a panel tab).
- Nav links navigate on press, not on release (`useRouteIntent`).
- Optimistic first: a mutation the user watches land carries `.withOptimisticUpdate` (`app/lib/agentConfigOptimistic.ts`, `app/lib/webhooksOptimistic.ts`).
- One field is edited inline, not in a modal: Enter or blur commits, Escape cancels (`InlineEdit`, `components/ui/inline-edit.tsx`). A dialog is for a choice with consequences, like a delete.
- Keyboard parity: what a pointer does, a key does too (`app/lib/shortcuts.ts`, claimed with `useShortcut`).

Effects

- Effects sync with something outside React: a socket, a timer, the DOM, a media query. Derive in render, act in handlers; when a prop change must reset state, adjust it during render (`useEverTrue`, `usePresence`, the name sync in `NodeSidePanel.tsx`).

Composition

- Extend a `ui` component with a variant, size or slot instead of copying its classes (Button `tone` and `variant="nav"`, TabsList `variant="line"`). A look one feature owns stays in that feature's component.

Performance

- A cold page fetches only its own tab: other tabs load through their `panels.ts` loaders, interaction-only components mount on first want (`useEverTrue`), the palette subscribes once it is wanted.
- Stream updates batch: at most one React commit per 50 ms (`STREAM_COMMIT_INTERVAL_MS` in `useAgentChat.ts`, held by `chatStream.spec.ts`).
- A list past about 200 rows pages (the Tracing task list's Load more), virtualizes, or sets `content-visibility: auto` on its rows.

# Tests

- `bun run test` is the unit suite (bun test) for pure helpers.
- `bun run test:ui` drives Playwright against the `/ui-gallery` fixture on a local `next dev`. The fixture renders the pieces that broke in the wild (select popup, onboarding card, canvas controls, save pill, press-and-drag row) with no Convex or WorkOS behind them, so a spec can assert real layout. For a layout bug: add the state to the fixture, write the spec under `e2e/ui` that fails on it, then fix. Dev only: the auth proxy lets the route through unauthenticated in development, and the page is a 404 everywhere else.
- `bun run test:app` and `bun run perf` are the signed-in suites, against a real Convex and WorkOS. Both need `E2E_EMAIL` + `E2E_PASSWORD`, a WorkOS user with email + password auth; `e2e/auth.setup.ts` signs it in once, provisions its org and default project on a fresh account, and saves the session under `e2e/.auth/`. `E2E_BASE_URL` picks the server: a deployment, or leave it unset for `http://localhost:3000`, where the config starts `next dev` on your `.env.local` (self-hosted Convex) unless one is already running. To run them against a self-hosted stack on your machine, with no WorkOS or internet, start it with `bun run local:up -- --dashboard` from the repo root, set `E2E_BASE_URL` to the dashboard URL it prints and `E2E_ADMIN_KEY=$(bun ../../scripts/local-stack.ts status --key)`; the admin key wins over the WorkOS login. Optional `E2E_PROJECT_ID` pins the project.
  - `app` (`e2e/app`) asserts behaviour: the home route opens the project, a cold project load is one document with no server action, no route refetch for the stage param, no logo fetch, and a page off the canvas subscribes to no palette data until the palette is wanted.
  - `perf` (`e2e/perf`) asserts time: every page has its content on screen within `PAGE_RENDER_BUDGET_MS` (`app/lib/perfReport.ts`) on the local server, cold and by client-side navigation. A deployment is held to `DEPLOYED_RENDER_BUDGET_MS` in the spec instead, since the runner's round trip to it is in the number. It also asserts size: a cold canvas, projects and dashboard (Monitoring tab) load may fetch no more JS chunks, and no more JS bytes (decoded, so the CDN's headers are not counted), before the load event than `e2e/perf/first-load-budget.json` allows, and every chunk must be `immutable`. More fails; fewer prints a hint to lock the gain in with `E2E_RECORD_FIRST_LOAD=1` against a build (`next dev` skips the budget). And it counts renders: `chatStream.spec.ts` replays a 26 KB answer over the Test tab's chat socket, one delta every 8 ms, and fails when React commits more than once per 50 ms of stream, with 1.5x headroom, which a chat that renders every chunk does. Self-hosted, it seeds an agent when the canvas has none; against WorkOS a canvas with no agent skips it.
  - `wireBudget.spec.ts` holds a cold canvas, Monitoring, Settings and projects load to the Convex query subscriptions and result bytes in `e2e/perf/wire-budget.json`, and names the heaviest queries when it fails. The numbers are the fixture's, so it gates only on a self-hosted stack (`E2E_ADMIN_KEY`), against a build; re-record with `E2E_RECORD_WIRE_BUDGET=1` after a gain or a fixture change.
  - CI runs them twice. On a pull request, at the end of `app-surfaces` in `ci.yaml`: the standalone build that job just made, served on the runner against the dev backend (`E2E_SERVER_COMMAND` hands Playwright's `webServer` the `server.js`). That run skips tests tagged `@rollout` (they need Convex functions only the merge deploys) and `@post-rollout` (they time the shared dev backend or a CSS transition, and flaked there). So the cold render budget (`PAGE_RENDER_BUDGET_MS`) and the collapsed-sidebar hover are checked only after a rollout. After each rollout, `e2e-dashboard.yaml` runs every spec against the deployment. The pull request path needs, in the GitHub `development` environment: secrets `DASHBOARD_E2E_EMAIL`, `DASHBOARD_E2E_PASSWORD`, `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD`; the existing var `NEXT_PUBLIC_CONVEX_URL`; and `http://localhost:3000/auth/callback` allowed as a redirect URI on the WorkOS app. `production` needs only the two login secrets, for a user in the production WorkOS environment, and that email on the Radar allow list (Radar > Restrictions): production AuthKit shows CI runners a bot check the probe cannot pass. `scripts/setup-dashboard-e2e.sh` at the repo root walks through creating the probe user and writing all of it.
  - The probe login for local runs (`e2e-probe@beeblast.co`, WorkOS Staging) is already saved as `E2E_EMAIL` / `E2E_PASSWORD` in the main checkout's `apps/dashboard/.env.local`. A worktree has no `.env.local`: copy it from the main checkout, then `bun --env-file=.env.local x playwright test --project=setup` signs in and every signed-in suite can run. Never reset the probe's password without also running `gh secret set DASHBOARD_E2E_PASSWORD --env development`: CI signs in as the same user, and every PR's `app-surfaces` fails until the secret matches.
  - For real usage data on dev, the probe's project (`silver-echo`, Development) has a `usage-probe` agent on `deepseek-flash` with public access. Read the stage key from the dashboard's Runtime key tab ("Reveal key") and send prompts with `new BroodsClient({ baseUrl: "https://gateway.dev.broods.app", apiKey }).run({ agentId, conversationKey, input })`, where `apiKey` is that key (or set `BROODS_API_KEY` and omit it); the Agent ID is on the agent's Details tab.
