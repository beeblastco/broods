import { defineAgent, env } from "filthy-panty";

export const search = defineAgent({
  name: "search",
  config: {
    provider: {
      google: {
        apiKey: env.GOOGLE_API_KEY,
      },
    },
    model: {
      provider: "google",
      modelId: "gemma-4-31b-it",
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
  },
});
