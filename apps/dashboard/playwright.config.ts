/**
 * Two browser suites, picked by project name:
 *
 * - `ui`: drives the /ui-gallery fixture on a local `next dev` and asserts
 *   real layout (popup placement, card overflow, tooltips, save pill).
 * - `perf`: signs in to a deployed dashboard and fails any page that takes
 *   longer than the render budget. Needs PERF_BASE_URL, PERF_EMAIL and
 *   PERF_PASSWORD; skipped without them.
 */
import { defineConfig, devices } from "@playwright/test";

const DEV_URL = "http://localhost:3000";
const GALLERY_URL = `${DEV_URL}/ui-gallery`;

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
      name: "perf",
      testMatch: /perf\/.*\.spec\.ts/,
      timeout: 120_000,
      use: { baseURL: process.env.PERF_BASE_URL },
    },
  ],
  webServer: process.env.PERF_BASE_URL
    ? undefined
    : {
        command: "bun run dev",
        url: GALLERY_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        // The fixture never talks to Convex or WorkOS; the app only needs
        // well-formed values to construct its clients and its auth proxy.
        // A real .env.local wins when present.
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
