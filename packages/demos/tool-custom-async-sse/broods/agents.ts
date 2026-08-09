import { defineAgent, defineTool, env } from "broods";

// Sleeps long enough that the run outlives a sync request.
export const testAsyncTool = defineTool({
  name: "test_async",
  description: "Test async tool.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  execute: async function () {
    await new Promise((resolve) => setTimeout(resolve, 5000));

    return { type: "text", value: "test_async completed successfully" };
  },
});

export const asyncToolAgent = defineAgent({
  name: "async-tool-agent",
  provider: {
    google: { apiKey: env("GOOGLE_API_KEY") },
  },
  model: {
    provider: "google",
    modelId: "gemma-4-31b-it",
  },
  agent: {
    system:
      "When the user asks, call the test_async tool and then report the injected async result.",
  },
  tools: {
    [testAsyncTool.name]: {
      enabled: true,
      async: true,
    },
  },
  publicAccess: true,
});
