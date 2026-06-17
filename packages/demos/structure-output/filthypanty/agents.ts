import { defineAgent, env } from "filthy-panty";

export const structuredAssistant = defineAgent({
  name: "structured-assistant",
  config: {
    provider: {
      google: { apiKey: env.GOOGLE_API_KEY },
    },
    model: {
      provider: "google",
      modelId: "gemma-4-31b-it",
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
  },
});
