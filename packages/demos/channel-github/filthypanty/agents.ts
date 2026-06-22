import { defineAgent, defineGitHubChannel, env } from "broods";

export const github = defineGitHubChannel({
  appId: env.GITHUB_APP_ID,
  privateKey: env.GITHUB_PRIVATE_KEY,
  webhookSecret: env.GITHUB_WEBHOOK_SECRET,
  allowedRepos: ["beeblastco/broods"],
});

export const agent = defineAgent({
  name: "github-channel-agent",
  config: {
    provider: { 
      minimax: { 
        apiKey: env.MINIMAX_API_KEY,
      } 
    },
    model: {
      provider: "minimax", 
      modelId: "MiniMax-M3",
    },
    agent: { 
      system: "Answer GitHub issues and pull request discussions concisely.",
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
    channels: [github],
  },
});
