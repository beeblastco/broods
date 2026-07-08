import { defineAgent, env } from "broods";

export const chat = defineAgent({
  name: "websocket-chat",
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
    },
    agent: {
      system: "You are a helpful assistant that can answer questions and provide information.",
    },
    publicAccess: true,
  },
});
