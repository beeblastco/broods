import type { Suite } from "../suite.ts";

export const suite: Suite = {
  name: "sandbox",
  tests: ["formal/replay/sandbox.test.ts"],
  env: {},
  mutations: [
    {
      name: "second daemon steals occupied slot",
      file: "apps/core/src/harness/sandbox/machine-executor.ts",
      find: "hello.force !== true &&",
      replace: "false &&",
    },
    {
      name: "same instance cannot reclaim",
      file: "apps/core/src/harness/sandbox/machine-executor.ts",
      find: "!(hello.instance && hello.instance === previous.instance)",
      replace: "true",
    },
    {
      name: "disk ignores persistence",
      file: "packages/convex/model/sandboxProviders.ts",
      find: 'sandbox.provider === "worker" && sandbox.persistent === true',
      replace: 'sandbox.provider === "worker"',
    },
    {
      name: "Daytona mount ignores opt in",
      file: "packages/convex/model/sandboxProviders.ts",
      find: "options?.mountAwsS3Buckets === true",
      replace: "true",
    },
    {
      name: "paths allow traversal",
      file: "apps/core/src/harness/tools/filesystem-utils.ts",
      find: 'if (parts.some((p) => p === ".."))',
      replace: "if (false)",
    },
    {
      name: "computer ignores explicit name",
      file: "apps/core/src/harness/tools/filesystem-utils.ts",
      find: "return machines.find((machine): boolean => machine.name === requested);",
      replace: "return machines[0];",
    },
    {
      name: "jobs allow cap plus one",
      file: "apps/core/src/harness/sandbox/jobs.ts",
      find: "-ge ${options.maxConcurrentJobs}",
      replace: "-gt ${options.maxConcurrentJobs}",
    },
    {
      name: "failed teardown not kept for the sweep",
      file: "apps/core/src/shared/sandbox-cleanup.ts",
      find: "if (!handedBack) {",
      replace: "if (false) {",
    },
    {
      name: "daemon parser uses wrong direction",
      file: "apps/core/src/shared/machine-socket.ts",
      find: "return parseFrame(daemonFrame, raw);",
      replace: "return parseFrame(coreFrame, raw);",
    },
  ],
};
