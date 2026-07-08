import { defineAgent, env } from "broods";

export const structuredAssistant = defineAgent({
  name: "structured-assistant",
  config: {
    provider: {
      custom: {
        apiKey: env.AI_API_KEY,
        base_url: env.AI_BASE_URL,
      },
    },
    model: {
      provider: "custom",
      modelId: "Qwen3.6-27B",
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
