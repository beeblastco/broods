import { defineAgent, defineTool, env } from "broods";

// `execute` is an async generator: every yield reaches the client as a
// preliminary tool result, and the last one is the result the model sees.
export const streamProgressTool = defineTool({
  name: "stream_progress",
  description: "Counts to `steps` and returns the final summary.",
  inputSchema: {
    type: "object",
    properties: {
      steps: {
        type: "number",
        description: "How many progress updates to stream.",
      },
    },
    additionalProperties: false,
  },
  async *execute(input: { steps?: number }) {
    const steps = Math.max(1, Math.min(10, input.steps ?? 5));
    for (let i = 1; i <= steps; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      yield { type: "text", value: `progress ${i}/${steps}` };
    }
    yield { type: "text", value: `done: counted to ${steps}` };
  },
});

export const streamingToolAgent = defineAgent({
  name: "streaming-tool-agent",
  provider: {
    custom: {
      apiKey: env("AI_API_KEY"),
      base_url: env("AI_BASE_URL"),
    },
  },
  model: {
    provider: "custom",
    modelId: "Qwen3.6-27B",
  },
  agent: {
    system:
      "You are a helpful assistant. When asked, call the stream_progress tool and then report its final result.",
  },
  tools: {
    [streamProgressTool.name]: {
      enabled: true,
    },
  },
  publicAccess: true,
});
