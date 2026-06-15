import { defineAgent, env } from "filthy-panty";

export const webhookAgent = defineAgent("webhook-agent", {
  provider: {
    google: { apiKey: env.GOOGLE_API_KEY },
  },
  model: {
    provider: "google",
    modelId: "gemma-4-31b-it",
  },
  agent: {
    system: "You are a helpful assistant. Answer the user's question briefly.",
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
      url: process.env.MOCK_WEBHOOK_URL!,
      secret: process.env.MOCK_WEBHOOK_SECRET!,
      events: [
        "agent.started",
        "tool.call.started",
        "tool.call.finished",
        "agent.finished",
        "agent.failed",
      ],
    },
  },
});
