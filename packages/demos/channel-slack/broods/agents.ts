import { defineAgent, defineSlackChannel, env } from "broods";

export const slack = defineSlackChannel({
  botToken: env.SLACK_BOT_TOKEN,
  signingSecret: env.SLACK_SIGNING_SECRET,
  allowedChannelIds: process.env.SLACK_ALLOWED_CHANNEL_IDS?.split(",").map((value) => value.trim()).filter(Boolean),
  reactionEmoji: process.env.SLACK_REACTION_EMOJI ?? "eyes",
});

export const agent = defineAgent({
  name: "slack-channel-agent",
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
    channels: [slack],
  },
});
