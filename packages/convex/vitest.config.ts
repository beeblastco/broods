import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    // Each file loads the full backend; more workers push cold imports past the test timeout.
    maxWorkers: 2,
    include: ["**/*.test.ts"],
    // Lean oracle tests need `lake build` first: only `verification:test` sets ORACLE_TESTS.
    exclude:
      process.env.ORACLE_TESTS === "1"
        ? configDefaults.exclude
        : [...configDefaults.exclude, "tests/*Oracle.test.ts"],
    // convex-test loads every module, and ./auth builds AuthKit, which checks these at import.
    env: {
      BROODS_AUTH_PROVIDER: "workos",
      WORKOS_CLIENT_ID: "client_test",
      WORKOS_API_KEY: "sk_test",
      WORKOS_WEBHOOK_SECRET: "whsec_test",
    },
  },
});
