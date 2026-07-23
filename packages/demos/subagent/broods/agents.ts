import { defineAgent, env } from "broods";

export const subagent = defineAgent({
  name: "subagent",
  description: "Specialized research agent",
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
      system: `Knowledge cutoff: January 2025.\n\nYou are a helpful personal assistant that can use tools to get information and perform tasks for the user.\n\nOnly answer the question, don't put additional information.`,
    },
    publicAccess: true,
  },
});

export const parent = defineAgent({
  name: "parent-agent",
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
      system:
        "You are a helpful assistant. Please answer based on the informations provided",
    },
    subagent: {
      enabled: true,
      allowed: [subagent],
      context: "new",
    },
    publicAccess: true,
  },
});
