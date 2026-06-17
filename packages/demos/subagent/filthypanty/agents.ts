import { defineAgent, env } from "filthy-panty";

export const subagent = defineAgent({
  name: "subagent",
  description: "Specialized research agent",
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
      system: `Knowledge cutoff: January 2025.\n\nYou are a helpful personal assistant that can use tools to get information and perform tasks for the user.\n\nYou also have access to web search and web fetch tools. Always use these tools to research and get up-to-date information or when you are asked for. Your knowledge was limited by cutoff training data date so do not rely on it for up-to-date information or fact checks. Only research and answer the question, don't put additional information.`,
    },
    tools: {
      tavilySearch: {
        enabled: true,
        apiKey: env.TAVILY_API_KEY,
        searchDepth: "advanced",
        topic: "news",
        includeAnswer: true,
        maxResults: 3,
      },
    },
  },
});

export const parent = defineAgent({
  name: "parent-agent",
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
      system: "You are a helpful assistant. Please answer based on the informations provided",
    },
    subagent: {
      enabled: true,
      allowed: [subagent],
      context: "new",
    },
  },
});
