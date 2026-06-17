import { defineAgent, defineTool, env } from "filthy-panty";

export const testAsyncTool = defineTool({
  name: "test_async",
  config: {
    path: "tools/test-async.ts",
    description: "Test async tool.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    defaultConfig: {},
  },
});

export const asyncToolAgent = defineAgent({
  name: "async-tool-agent",
  config: {
    provider: {
      google: { apiKey: env.GOOGLE_API_KEY },
    },
    model: {
      provider: "google",
      modelId: "gemma-4-31b-it",
    },
    agent: {
      system: "When the user asks, call the test_async tool and then report the injected async result.",
    },
    tools: {
      [testAsyncTool.name]: {
        enabled: true,
        async: true,
      },
    },
  },
});
