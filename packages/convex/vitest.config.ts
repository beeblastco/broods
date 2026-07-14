import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    // Every *.test.ts here, not a hand-listed file: an explicit list silently
    // skips new test files, which is indistinguishable from them passing.
    include: ["*.test.ts"],
    // convex-test loads every module in the deployment, so any test that reaches
    // a module importing ./auth constructs AuthKit, which validates these at
    // import time. Dummy values only — nothing here authenticates.
    env: {
      WORKOS_CLIENT_ID: "client_test",
      WORKOS_API_KEY: "sk_test",
      WORKOS_WEBHOOK_SECRET: "whsec_test",
    },
  },
});
