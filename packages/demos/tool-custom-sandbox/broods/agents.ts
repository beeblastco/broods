import { defineAgent, defineTool, env } from "broods";

// No `runtime` here on purpose: the classifier reads the bundle, sees the `node:`
// imports, and routes it to the sandbox tier by itself.
export const systemReportTool = defineTool({
  name: "system_report",
  path: "tools/system-report.ts",
  description:
    "Hashes and compresses a string inside the sandbox runtime, returning the digest, gzip size, and the runner's Node version.",
  inputSchema: {
    type: "object",
    properties: {
      payload: {
        type: "string",
        description: "Text to hash and compress.",
      },
    },
    required: ["payload"],
    additionalProperties: false,
  },
});

export const sandboxToolAgent = defineAgent({
  name: "sandbox-tool-agent",
  provider: {
    custom: {
      apiKey: env.AI_API_KEY,
      base_url: env.AI_BASE_URL,
    },
  },
  model: {
    provider: "custom",
    modelId: "Qwen3.6-27B",
  },
  agent: {
    system:
      "You are a helpful assistant. When asked, call the system_report tool and report every field it returns.",
  },
  tools: {
    [systemReportTool.name]: {
      enabled: true,
    },
  },
  publicAccess: true,
});
