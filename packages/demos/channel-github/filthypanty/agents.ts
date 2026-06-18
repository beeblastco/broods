import { defineAgent, defineGitHubChannel, env } from "filthy-panty";

export const github = defineGitHubChannel({
  appId: env.GITHUB_APP_ID,
  privateKey: env.GITHUB_PRIVATE_KEY,
  webhookSecret: env.GITHUB_WEBHOOK_SECRET,
  allowedRepos: ["beeblastco/filthy-panty"],
});

export const agent = defineAgent({
  name: "github-channel-agent",
  config: {
    provider: { minimax: { apiKey: env.MINIMAX_API_KEY } },
    model: { provider: "minimax", modelId: "MiniMax-M3" },
    agent: { system: "Answer GitHub issues and pull request discussions concisely." },
    channels: [github],
  },
});
