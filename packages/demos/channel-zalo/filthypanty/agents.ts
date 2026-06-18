import { defineAgent, defineZaloChannel, env } from "filthy-panty";

export const zalo = defineZaloChannel({
  botToken: env.ZALO_BOT_TOKEN,
  webhookSecret: env.ZALO_WEBHOOK_SECRET,
  allowedUserIds: process.env.ZALO_ALLOWED_USER_IDS?.split(",").map((value) => value.trim()).filter(Boolean) ?? [],
  streaming: { mode: "chunk" },
});

export const agent = defineAgent({
  name: "zalo-channel-agent",
  config: {
    provider: { minimax: { apiKey: env.MINIMAX_API_KEY } },
    model: { provider: "minimax", modelId: "MiniMax-M3" },
    agent: { system: "You are a concise Zalo assistant." },
    channels: [zalo],
  },
});
