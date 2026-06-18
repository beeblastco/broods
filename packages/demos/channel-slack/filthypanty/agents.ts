import { defineAgent, defineSlackChannel, env } from "filthy-panty";

export const slack = defineSlackChannel({
  botToken: env.SLACK_BOT_TOKEN,
  signingSecret: env.SLACK_SIGNING_SECRET,
  allowedChannelIds: process.env.SLACK_ALLOWED_CHANNEL_IDS?.split(",").map((value) => value.trim()).filter(Boolean),
  streaming: { mode: "edit" },
});

export const agent = defineAgent({
  name: "slack-channel-agent",
  config: {
    provider: { minimax: { apiKey: env.MINIMAX_API_KEY } },
    model: { provider: "minimax", modelId: "MiniMax-M3" },
    agent: { system: "You are a concise Slack assistant." },
    channels: [slack],
  },
});
