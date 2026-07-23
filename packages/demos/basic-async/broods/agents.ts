import { defineAgent, env } from "broods";

export const search = defineAgent({
  name: "async-search",
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
      system: "You are a helpful assistant.",
    },
    publicAccess: true,
  },
});
