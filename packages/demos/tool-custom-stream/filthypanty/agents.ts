import { defineAgent, defineTool, env } from "filthy-panty";

export const streamProgressTool = defineTool({
  name: "stream_progress",
  config: {
    path: "tools/stream-progress.ts",
    description: "Counts to `steps`, streaming one progress update per step before the final summary.",
    inputSchema: {
      type: "object",
      properties: {
        steps: { type: "number", description: "How many progress updates to stream." },
      },
      required: ["steps"],
      additionalProperties: false,
    },
    defaultConfig: {},
  },
});

export const streamingToolAgent = defineAgent({
  name: "streaming-tool-agent",
  config: {
    provider: {
      minimax: { apiKey: env.MINIMAX_API_KEY },
    },
    model: {
      provider: "minimax",
      modelId: "MiniMax-M3",
    },
    agent: {
      system: "You are a helpful assistant. When asked, call the stream_progress tool and then report its final result.",
    },
    tools: {
      [streamProgressTool.name]: {
        enabled: true,
      },
    },
  },
});
