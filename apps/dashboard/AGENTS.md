<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Tests

- `bun run test` is the unit suite (bun test) for pure helpers.
- `bun run test:ui` drives Playwright against the `/ui-gallery` fixture on a local `next dev`. The fixture renders the pieces that broke in the wild (select popup, onboarding card, canvas controls, save pill) with no Convex or WorkOS behind them, so a spec can assert real layout. For a layout bug: add the state to the fixture, write the spec under `e2e/ui` that fails on it, then fix. Dev only: the auth proxy lets the route through unauthenticated in development, and the page is a 404 everywhere else.
- `bun run test:app` and `bun run perf` are the signed-in suites, against a real Convex and WorkOS. Both need `E2E_EMAIL` + `E2E_PASSWORD`, a WorkOS user with email + password auth; `e2e/auth.setup.ts` signs it in once, provisions its org and default project on a fresh account, and saves the session under `e2e/.auth/`. `E2E_BASE_URL` picks the server: a deployment, or leave it unset for `http://localhost:3000`, where the config starts `next dev` on your `.env.local` (self-hosted Convex) unless one is already running. Optional `E2E_PROJECT_ID` pins the project.
  - `app` (`e2e/app`) asserts behaviour: the home route opens the project, a cold project load is one document with no server action, no route refetch for the stage param, no logo fetch.
  - `perf` (`e2e/perf`) asserts time: every page has its content on screen within `PAGE_RENDER_BUDGET_MS` (`app/lib/perfReport.ts`), cold and by client-side navigation.
  - `.github/workflows/e2e-dashboard.yaml` runs both on every pull request that touches the dashboard (the PR's build, started on the runner against the dev backend) and after each rollout (against the deployment). It needs, in the GitHub `development` environment: secrets `DASHBOARD_E2E_EMAIL`, `DASHBOARD_E2E_PASSWORD`, `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD`; the existing var `NEXT_PUBLIC_CONVEX_URL`; and `http://localhost:3000/auth/callback` allowed as a redirect URI on the WorkOS app. `production` needs only the two login secrets, for a user in the production WorkOS environment. `scripts/setup-dashboard-e2e.sh` at the repo root walks through creating the probe user and writing all of it.
