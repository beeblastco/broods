import { defineAgent, env } from "filthy-panty";

export const webhookAgent = defineAgent({
  name: "webhook-agent",
  config: {
    provider: {
      minimax: { apiKey: env.MINIMAX_API_KEY },
    },
    model: {
      provider: "minimax",
      modelId: "MiniMax-M3",
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
      webhook: {
        enabled: true,
        url: env.MOCK_WEBHOOK_URL!,
        secret: env.MOCK_WEBHOOK_SECRET!,
        events: [
          "agent.started",
          "tool.call.started",
          "tool.call.finished",
          "agent.finished",
          "agent.failed",
        ],
      },
    },
  },
});
