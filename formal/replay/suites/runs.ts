import type { Suite } from "../suite.ts";

// Each fault changes real loaded source; no file on disk is patched.
export const suite: Suite = {
  name: "runs",
  tests: ["formal/replay/runs.test.ts"],
  env: {},
  mutations: [
    {
      name: "stale generation passes owner fence",
      file: "packages/convex/runtimeIngress.ts",
      find: "coordinator.ownerGeneration !== options.ownerGeneration ||",
      replace: "false ||",
    },
    {
      name: "followup batch consumes following messages",
      file: "packages/convex/runtimeIngress.ts",
      find: 'first.requestedMode === "collect" || first.requestedMode === "steer";',
      replace: "true;",
    },
    {
      name: "steering jumps a followup barrier",
      file: "packages/convex/runtimeIngress.ts",
      find: 'const steering = active[0]?.requestedMode === "steer";',
      replace: "const steering = active.length > 0;",
    },
    {
      name: "takeNext promotes for a suspended account",
      file: "packages/convex/runtimeIngress.ts",
      find: 'account?.status === "active"',
      replace: "account !== null",
    },
    {
      name: "shed release ignores requeue",
      file: "packages/convex/runtimeIngress.ts",
      find: "args.requeue === true",
      replace: "false",
    },
    {
      name: "requeue leaves the queue counter",
      file: "packages/convex/runtimeIngress.ts",
      find: "queue.queuedCount += 1;",
      replace: "",
    },
    {
      name: "continuation accepts empty tool input",
      file: "apps/core/src/harness/pruning.ts",
      find: "message.content.length > 0 &&",
      replace: "true &&",
    },
    {
      name: "failure loses settlement priority",
      file: "apps/core/src/harness/continuation.ts",
      find: 'if (result.didFail) {\n    return {\n      status: "failed",',
      replace: 'if (false) {\n    return {\n      status: "failed",',
    },
    {
      name: "question numeric option uses zero-based index",
      file: "apps/core/src/harness/questions.ts",
      find: "question.options[Number(trimmed) - 1]",
      replace: "question.options[Number(trimmed)]",
    },
    {
      name: "async identity truncates ordinary ids",
      file: "apps/core/src/harness/async-tool-result.ts",
      find: "const CONTINUATION_TAG = /:async-(?:bg|question|subagent|tools)(?::|$)/;",
      replace:
        "const CONTINUATION_TAG = /async-(?:bg|question|subagent|tools)(?::|$)/;",
    },
  ],
};
