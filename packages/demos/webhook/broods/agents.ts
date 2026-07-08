import { defineAgent, env } from "broods";

export const webhookAgent = defineAgent({
  name: "webhook-agent",
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
      system: "You are a helpful assistant. You can call tools and provide information to the user.",
    },
    tools: {
      tavilySearch: {
        enabled: true,
        apiKey: env.TAVILY_API_KEY,
        searchDepth: "advanced",
        includeAnswer: true,
        maxResults: 5,
        topic: "news",
      },
    },
    hooks: {
      // An agent can register several outbound webhooks — add more entries to fan
      // events out to multiple of your services.
      webhooks: [{
        enabled: true,
        url: env.WEBHOOK_URL!,
        secret: env.WEBHOOK_SECRET!,
        events: [
          "agent.started",
          "tool.call.started",
          "tool.call.finished",
          "agent.finished",
          "agent.failed",
        ],
      }],
    },
    publicAccess: true,
  },
});
