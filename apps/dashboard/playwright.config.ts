import { defineConfig, devices } from "@playwright/test";
import {
  BASE_URL,
  DEV_URL,
  probeAccount,
  STORAGE_STATE,
} from "./e2e/lib/session";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  // With the admin key the seat billing spec runs and flips deployment-wide state every
  // app and perf spec reads; against WorkOS it skips.
  workers: probeAccount.adminKey ? 1 : undefined,
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
      // Only here: a signed-in trace carries the session cookie into CI artifacts.
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
        // Placeholders only build the clients. `||`, not `??`: CI passes an unset secret as "",
        // and an empty cookie password crashes the server.
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
          // Panels open their socket only with a gateway set; the ui specs answer it.
          NEXT_PUBLIC_BROODS_BASE_URL:
            process.env.NEXT_PUBLIC_BROODS_BASE_URL || "http://localhost:3999",
        },
      },
});
