import { defineAgent, defineZaloConnection, env } from "broods";

const allowedUserIds = (process.env.ZALO_ALLOWED_USER_IDS?.split(",") ?? [])
  .map((value) => value.trim())
  .filter(Boolean);

// A Zalo chat id does not exist until someone writes, so the rooms cannot be
// declared as channels up front, and the wildcard says so. Set
// ZALO_ALLOWED_USER_IDS to gate who is answered; leave it unset and the demo
// answers anyone. Both are checked while parsing the webhook.
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
