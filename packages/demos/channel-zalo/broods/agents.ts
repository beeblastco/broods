import { defineAgent, defineZaloChannel, env } from "broods";

export const zalo = defineZaloChannel({
  botToken: env("ZALO_BOT_TOKEN"),
  webhookSecret: env("ZALO_WEBHOOK_SECRET"),
  allowedUserIds:
    process.env.ZALO_ALLOWED_USER_IDS?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? [],
  allowedGroupIds:
    process.env.ZALO_ALLOWED_GROUP_IDS?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? [],
  ...(process.env.ZALO_BOT_NAME
    ? { botName: process.env.ZALO_BOT_NAME }
    : {}),
});

export const agent = defineAgent({
  name: "zalo-channel-agent",
  provider: {
    custom: {
      apiKey: env("AI_API_KEY"),
      base_url: env("AI_BASE_URL"),
    },
  },
  model: {
    provider: "custom",
    modelId: "Qwen3.6-27B",
  },
  agent: {
    system: "You are a helpful assistant.",
  },
  channels: [zalo],
});
