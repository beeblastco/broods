import { defineAgent, env } from "filthy-panty";

export const approvalAgent = defineAgent({
  name: "approval-agent",
  config: {
    provider: {
      google: { apiKey: env.GOOGLE_API_KEY },
    },
    model: {
      provider: "google",
      modelId: "gemma-4-31b-it",
    },
    agent: {
      system: "Use Tavily search when current web information is needed.",
    },
    tools: {
      tavilySearch: {
        enabled: true,
        needsApproval: true,
        apiKey: env.TAVILY_API_KEY,
        searchDepth: "advanced",
        includeAnswer: true,
        maxResults: 3,
      },
    },
  },
});
