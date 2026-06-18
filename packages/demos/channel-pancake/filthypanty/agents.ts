import { defineAgent, definePancakeChannel, env } from "filthy-panty";

export const pancake = definePancakeChannel({
  pageId: env.PANCAKE_PAGE_ID,
  pageAccessToken: env.PANCAKE_PAGE_ACCESS_TOKEN,
  webhookSecret: env.PANCAKE_WEBHOOK_SECRET,
  senderId: env.PANCAKE_SENDER_ID,
  ignoreTagIds: process.env.PANCAKE_IGNORE_TAG_IDS?.split(",").map((value) => value.trim()).filter(Boolean),
  streaming: { mode: "chunk" },
});

export const agent = defineAgent({
  name: "pancake-channel-agent",
  config: {
    provider: { minimax: { apiKey: env.MINIMAX_API_KEY } },
    model: { provider: "minimax", modelId: "MiniMax-M3" },
    agent: { system: "You are a concise customer support assistant." },
    channels: [pancake],
  },
});
