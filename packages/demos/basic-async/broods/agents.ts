import { defineAgent, env } from "broods";

export const search = defineAgent({
  name: "async-search",
  config: {
    provider: {
      minimax: { 
        apiKey: env.MINIMAX_API_KEY 
      },
    },
    model: {
      provider: "minimax",
      modelId: "MiniMax-M3",
    },
    agent: {
      system: "You are a helpful assistant.",
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
    publicAccess: true,
  },
});
