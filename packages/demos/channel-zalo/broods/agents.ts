import { defineAgent, definePolicy, defineZaloConnection, env } from "broods";

const allowedChatIds = [
  ...(process.env.ZALO_ALLOWED_USER_IDS?.split(",") ?? []),
  ...(process.env.ZALO_ALLOWED_GROUP_IDS?.split(",") ?? []),
]
  .map((value) => value.trim())
  .filter(Boolean);

export const zalo = defineZaloConnection({
  botToken: env("ZALO_BOT_TOKEN"),
  webhookSecret: env("ZALO_WEBHOOK_SECRET"),
});

// Reach is deny-by-default. Zalo chats cannot be listed as channels up front —
// a new person's chat id does not exist until they write — so a policy decides.
export const reach = definePolicy({
  name: "zalo-reach",
  rules: [
    {
      action: "agent.invoke",
      effect: "allow",
      ...(allowedChatIds.length > 0
        ? {
            conditions: [
              {
                attribute: "channelId",
                operator: "in",
                value: allowedChatIds,
              },
            ],
          }
        : {}),
    },
  ],
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
  policy: { policies: [reach] },
});
