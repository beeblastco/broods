/**
 * Browser suites, picked by project name:
 *
 * - `ui`: drives the /ui-gallery fixture on a local `next dev` and asserts
 *   real layout (popup placement, card overflow, tooltips, save pill). No
 *   backend behind it.
 * - `setup`: signs in the probe account through hosted AuthKit once and saves
 *   the session; `app` and `perf` depend on it.
 * - `app`: signed-in behaviour of the real pages against a real Convex and
 *   WorkOS.
 * - `perf`: cold and navigated render times against the budget.
 *
 * The signed-in suites need E2E_EMAIL and E2E_PASSWORD, and run against
 * E2E_BASE_URL: a deployment, or a local server on the self-hosted backend
 * (default http://localhost:3000, started here when not already running;
 * E2E_SERVER_COMMAND swaps `next dev` for another server, which is how CI
 * runs the standalone build). They skip without the account.
 */
import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, DEV_URL, STORAGE_STATE } from "./e2e/lib/session";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    colorScheme: "dark",
  },
  projects: [
    {
      name: "ui",
      testMatch: /ui\/.*\.spec\.ts/,
      // Traces only here: the signed-in projects must not record one, it
      // carries the session cookie and the sign-in POST into CI artifacts.
      use: { baseURL: DEV_URL, trace: "retain-on-failure" },
    },
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
      use: { baseURL: BASE_URL },
    },
    {
      name: "app",
      testMatch: /app\/.*\.spec\.ts/,
      dependencies: ["setup"],
      use: { baseURL: BASE_URL, storageState: STORAGE_STATE },
    },
    {
      name: "perf",
      testMatch: /perf\/.*\.spec\.ts/,
      dependencies: ["setup"],
      timeout: 120_000,
      use: { baseURL: BASE_URL },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: process.env.E2E_SERVER_COMMAND || "bun run dev",
        url: `${DEV_URL}/healthz`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        // The fixture never talks to Convex or WorkOS; the app only needs
        // well-formed values to construct its clients and its auth proxy.
        // A real .env.local wins when present, which is what the signed-in
        // suites need locally. `||`, not `??`: CI passes an unset secret as
        // an empty string, and an empty cookie password crashes the server.
        env: {
          NEXT_PUBLIC_CONVEX_URL:
            process.env.NEXT_PUBLIC_CONVEX_URL ||
            "https://placeholder.convex.cloud",
          WORKOS_API_KEY: process.env.WORKOS_API_KEY || "sk_test_placeholder",
          WORKOS_CLIENT_ID:
            process.env.WORKOS_CLIENT_ID || "client_placeholder",
          WORKOS_COOKIE_PASSWORD:
            process.env.WORKOS_COOKIE_PASSWORD ||
            "ui-gallery-placeholder-cookie-password-32",
          NEXT_PUBLIC_WORKOS_REDIRECT_URI:
            process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ||
            "http://localhost:3000/auth/callback",
        },
      },
});
