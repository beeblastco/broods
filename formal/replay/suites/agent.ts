import type { Suite } from "../suite.ts";

export const suite: Suite = {
  name: "agent",
  tests: ["formal/replay/agent.test.ts"],
  env: {},
  mutations: [
    {
      name: "hook accepts unknown fields",
      file: "apps/core/src/harness/hook-runner.ts",
      find: "const allowed = HOOK_MUTABLE_FIELDS[event];",
      replace: "const allowed = Object.keys(returned);",
    },
    {
      name: "entry batch one row too large",
      file: "packages/convex/model/harnessSessionEntries.ts",
      find: "batches.at(-1)!.length >= ENTRY_BATCH.rows",
      replace: "batches.at(-1)!.length > ENTRY_BATCH.rows",
    },
    {
      name: "running handbacks accepted",
      file: "packages/convex/model/subagentResults.ts",
      find: 'status !== "awaiting_input"',
      replace: 'status !== "awaiting_input" && status !== "running"',
    },
    {
      name: "compatibility overrides deny",
      file: "apps/core/src/harness/policy.ts",
      find: 'approvalDecision(policy) === "denied"',
      replace: 'approvalDecision(policy) === "approved"',
    },
    {
      name: "disabled compaction still handles overflow",
      file: "apps/core/src/harness/compaction.ts",
      find: "if (config?.enabled === false) return false;",
      replace:
        "if (config?.enabled === false && !contextExceeded) return false;",
    },
    {
      name: "threshold is exclusive",
      file: "apps/core/src/harness/compaction.ts",
      find: "lastInputTokens >= configuredMax",
      replace: "lastInputTokens > configuredMax",
    },
    {
      name: "deadline ignores pending questions",
      file: "apps/core/src/harness/deadline-policy.ts",
      find: "questionsPending > 0",
      replace: "questionsPending > 999",
    },
    {
      name: "zero finish erases usage",
      file: "apps/core/src/harness/usage-metering.ts",
      find: "tokens > 0",
      replace: "tokens >= 0",
    },
    {
      name: "cache writes priced as uncached",
      file: "packages/convex/model/modelPricing.ts",
      find: "usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens",
      replace: "usage.inputTokens - usage.cachedInputTokens",
    },
  ],
};
