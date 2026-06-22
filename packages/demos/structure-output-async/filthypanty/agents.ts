import { defineAgent, env } from "broods";

export const structuredAssistant = defineAgent({
  name: "structured-assistant",
  config: {
    provider: {
      minimax: {
        apiKey: env.MINIMAX_API_KEY
      },
    },
    model: {
      provider: "minimax",
      modelId: "MiniMax-M3",
      output: {
        type: "object",
        name: "AgentAnswer",
        description: "A concise answer with optional follow-up actions.",
        schema: {
          type: "object",
          properties: {
            answer: { type: "string" },
            actions: {
              type: "array",
              items: { type: "string" }
            }
          },
          required: ["answer"],
          additionalProperties: false
        }
      }
    },
    agent: {
      system: "You are a helpful assistant that returns structured output.",
    },
    publicAccess: true,
  },
});
