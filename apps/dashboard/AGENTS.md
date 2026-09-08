<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Tests

- `bun run test` is the unit suite (bun test) for pure helpers.
- `bun run test:ui` drives Playwright against the `/ui-gallery` fixture on a local `next dev`. The fixture renders the pieces that broke in the wild (select popup, onboarding card, canvas controls, save pill) with no Convex or WorkOS behind them, so a spec can assert real layout. For a layout bug: add the state to the fixture, write the spec under `e2e/ui` that fails on it, then fix. Dev only: the auth proxy lets the route through unauthenticated in development, and the page is a 404 everywhere else.
- `bun run perf` is the render-budget probe against a deployed dashboard. Needs `PERF_BASE_URL`, `PERF_EMAIL`, `PERF_PASSWORD` (a WorkOS user with email + password auth in an org that owns a project), optional `PERF_PROJECT_ID`. Every page has to have its content on screen within `PAGE_RENDER_BUDGET_MS` (`app/lib/perfReport.ts`), cold and by client-side navigation. `.github/workflows/perf-dashboard.yaml` runs it after each dashboard rollout.
