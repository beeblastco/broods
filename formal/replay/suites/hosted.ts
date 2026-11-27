import type { Suite } from "../suite.ts";

export const suite: Suite = {
  name: "hosted",
  tests: ["formal/replay/hosted.test.ts"],
  env: {},
  mutations: [
    {
      name: "drop final frames",
      file: "apps/core/src/harness/frames.ts",
      find: 'parsed.t === "final"',
      replace: 'parsed.t === "missing"',
    },
    {
      name: "discard trailing line",
      file: "apps/core/src/harness/frames.ts",
      find: "const frame = parseRunnerFrame(this.#buffer);",
      replace: "const frame = null;",
    },
    {
      name: "terminal does not stop collection",
      file: "apps/core/src/harness/mcp/hosted.ts",
      find: "      break;",
      replace: "      continue;",
    },
    {
      name: "batch ignores agent",
      file: "apps/core/src/harness/mcp/hosted.ts",
      find: "return agentId ? `${accountId}:${agentId}` : accountId;",
      replace: "return accountId;",
    },
    {
      name: "batch maximum off by one",
      file: "apps/core/src/harness/mcp/hosted.ts",
      find: 'batch.calls.length >= positiveIntegerEnv("MCP_BATCH_MAX", DEFAULT_BATCH_MAX)',
      replace:
        'batch.calls.length > positiveIntegerEnv("MCP_BATCH_MAX", DEFAULT_BATCH_MAX)',
    },
    {
      name: "allow skill traversal",
      file: "packages/convex/model/skillRules.ts",
      find: 'part === ".." || part === ""',
      replace: 'part === ""',
    },
    {
      name: "allow runtime on HTTP",
      file: "packages/convex/model/mcp.ts",
      find: 'row.runtime !== undefined && row.transport !== "hosted"',
      replace: "false",
    },
    {
      name: "cancelled task becomes failure",
      file: "apps/core/src/harness/mcp-tasks.ts",
      find: "if (current.stoppedByUser)",
      replace: "if (false)",
    },
    {
      name: "listing TTL uncapped",
      file: "apps/core/src/harness/mcp/client.ts",
      find: "    MAX_TTL_MS,",
      replace: "    Number.MAX_SAFE_INTEGER,",
    },
    {
      name: "rate wait uncapped",
      file: "apps/core/src/harness/mcp/client.ts",
      find: "Math.min(Math.ceil(askedMs), MAX_RATE_LIMIT_WAIT_MS)",
      replace: "Math.ceil(askedMs)",
    },
    {
      name: "retry uncertain network errors",
      file: "apps/core/src/harness/mcp/hosted.ts",
      find: "if (isUnreachableError(error))",
      replace: "if (true)",
    },
    {
      name: "trust HTTP 422 without signal",
      file: "apps/core/src/harness/mcp/hosted.ts",
      find: "response.headers.has(WORKER_NOTHING_RAN_HEADER)",
      replace: "response.status === 422",
    },
    {
      name: "semantic retry exceeds cap",
      file: "apps/core/src/harness/mcp/client.ts",
      find: "const RATE_LIMIT_RETRIES = 3;",
      replace: "const RATE_LIMIT_RETRIES = 4;",
    },
    {
      name: "tool call drops its definition",
      file: "apps/core/src/harness/mcp/client.ts",
      find: "...(options.toolDefinition\n",
      replace: "...(false\n",
    },
    {
      name: "input_required rounds unpinned",
      file: "apps/core/src/harness/mcp/client.ts",
      find: "const INPUT_REQUIRED_MAX_ROUNDS = 10;",
      replace: "const INPUT_REQUIRED_MAX_ROUNDS = 11;",
    },
    {
      name: "Lambda child ignores tenant",
      file: "apps/lambda/handler.mjs",
      find: "`${event.tenantId}:${event.expectedSha256}`",
      replace: "event.expectedSha256",
    },
    {
      name: "Worker loader ignores tenant",
      file: "apps/cloudflare-mcp/src/index.ts",
      find: "`${batch.tenantId}:${batch.expectedSha256}`",
      replace: "batch.expectedSha256",
    },
  ],
};

// Private functions read their actual source bodies; hosted-preload.ts confines faults to exact
// paths because the shared preload matches every client.ts basename, including SDK packages.
