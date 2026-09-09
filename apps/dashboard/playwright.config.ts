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
 * (default http://localhost:3000, started here when not already running).
 * They skip without the account.
 */
import { defineConfig, devices } from "@playwright/test";
import { STORAGE_STATE } from "./e2e/lib/session";

// Next reads .env.local for the app; Playwright does not, so the E2E_* values
// kept there (by scripts/setup-dashboard-e2e.sh) are loaded here. Absent in
// CI, where the workflow sets the environment.
try {
  process.loadEnvFile(".env.local");
} catch {
  // No local env file: the suites read whatever the shell provides.
}

const DEV_URL = "http://localhost:3000";
const GALLERY_URL = `${DEV_URL}/ui-gallery`;
const BASE_URL = process.env.E2E_BASE_URL ?? DEV_URL;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    colorScheme: "dark",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "ui",
      testMatch: /ui\/.*\.spec\.ts/,
      use: { baseURL: DEV_URL },
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
        command: "bun run dev",
        url: GALLERY_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        // The fixture never talks to Convex or WorkOS; the app only needs
        // well-formed values to construct its clients and its auth proxy.
        // A real .env.local wins when present, which is what the signed-in
        // suites need locally.
        env: {
          NEXT_PUBLIC_CONVEX_URL:
            process.env.NEXT_PUBLIC_CONVEX_URL ??
            "https://placeholder.convex.cloud",
          WORKOS_API_KEY: process.env.WORKOS_API_KEY ?? "sk_test_placeholder",
          WORKOS_CLIENT_ID:
            process.env.WORKOS_CLIENT_ID ?? "client_placeholder",
          WORKOS_COOKIE_PASSWORD:
            process.env.WORKOS_COOKIE_PASSWORD ??
            "ui-gallery-placeholder-cookie-password-32",
          NEXT_PUBLIC_WORKOS_REDIRECT_URI:
            process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ??
            "http://localhost:3000/auth/callback",
        },
      },
});
