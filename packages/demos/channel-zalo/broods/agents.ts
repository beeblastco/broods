import { defineAgent, defineZaloConnection, env } from "broods";

const allowedUserIds = (process.env.ZALO_ALLOWED_USER_IDS?.split(",") ?? [])
  .map((value) => value.trim())
  .filter(Boolean);

// A Zalo chat id exists only once someone writes, so no channel can be declared up front.
// Leave ZALO_ALLOWED_USER_IDS unset and the demo answers anyone.
export const zalo = defineZaloConnection({
  allowedChannelIds: ["*"],
  ...(allowedUserIds.length > 0 ? { allowedUserIds: allowedUserIds } : {}),
  botToken: env("ZALO_BOT_TOKEN"),
  webhookSecret: env("ZALO_WEBHOOK_SECRET"),
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
  connections: [zalo],
});
