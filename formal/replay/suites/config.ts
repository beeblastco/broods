import type { Suite } from "../suite.ts";

// Each replacement is applied in memory by mutate-preload, never to repository source.
export const suite: Suite = {
  name: "config",
  tests: ["formal/replay/config.test.ts"],
  env: {},
  mutations: [
    {
      name: "wrong authentication error",
      file: "packages/convex/model/apiError.ts",
      find: '401: { code: "unauthorized", type: "authentication_error" }',
      replace: '401: { code: "forbidden", type: "authentication_error" }',
    },
    {
      name: "discard explicit code",
      file: "packages/convex/model/apiError.ts",
      find: "init.code ?? byStatus(status).code",
      replace: "byStatus(status).code",
    },
    {
      name: "accept unknown client code",
      file: "packages/convex/model/clientError.ts",
      find: "Object.hasOwn(CLIENT_ERROR_STATUS, code)",
      replace: "true",
    },
    {
      name: "retired key is current",
      file: "packages/convex/model/envelope.ts",
      find: "keys.findLast((key) => key.retiredAt === undefined)",
      replace: "keys.findLast((key) => key.retiredAt !== undefined)",
    },
    {
      name: "rewriting ignores key id",
      file: "packages/convex/model/envelope.ts",
      find: "return blobKeyId(blob) !== this.currentKeyId;",
      replace: "return false;",
    },
    {
      name: "null does not delete config",
      file: "packages/convex/model/configValues.ts",
      find: "if (patch === null) {\n    return undefined;",
      replace: "if (patch === null) {\n    return null;",
    },
    {
      name: "allow zero positive integer",
      file: "packages/convex/model/inputSchema.ts",
      find: "Number.isSafeInteger(value) && value >= 1 && value <= max",
      replace: "Number.isSafeInteger(value) && value >= 0 && value <= max",
    },
    {
      name: "request id ceiling off by one",
      file: "packages/convex/model/requestId.ts",
      find: "{1,128}",
      replace: "{1,129}",
    },
    {
      name: "allow http URL",
      file: "packages/convex/model/agentRules.ts",
      find: 'url.protocol !== "https:"',
      replace: 'url.protocol !== "https:" && url.protocol !== "http:"',
    },
    {
      name: "allow private IPv4",
      file: "packages/convex/model/agentRules.ts",
      find: "a === 10 ||",
      replace: "false ||",
    },
    {
      name: "base alias precedence reversed",
      file: "packages/convex/model/agentRules.ts",
      find: 'typeof config.base_url === "string" ? config.base_url : config.baseURL',
      replace:
        'typeof config.baseURL === "string" ? config.baseURL : config.base_url',
    },
    {
      name: "reserved tools need no provider type",
      file: "packages/convex/model/agentRules.ts",
      find: 'isHarnessToolName(name) && entry.type !== "provider"',
      replace: "false",
    },
    {
      name: "tool prefix accepted",
      file: "packages/convex/model/agentRules.ts",
      find: "!toolName.startsWith(DEPRECATED_TOOL_ID_PREFIX)",
      replace: "true",
    },
    {
      name: "workspace allowed on first sandbox",
      file: "packages/convex/model/sandboxMounts.ts",
      find: "index === 0",
      replace: "index === -1",
    },
    {
      name: "retry header can be zero",
      file: "packages/convex/model/httpJson.ts",
      find: "Math.max(1, Math.ceil(resetSeconds))",
      replace: "Math.ceil(resetSeconds)",
    },
  ],
};
