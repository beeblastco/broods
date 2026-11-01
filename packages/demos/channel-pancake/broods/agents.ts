import { defineAgent, definePancakeConnection, env } from "broods";

export const pancake = definePancakeConnection({
  allowedChannelIds: ["*"],
  pageId: env("PANCAKE_PAGE_ID"),
  pageAccessToken: env("PANCAKE_PAGE_ACCESS_TOKEN"),
  webhookSecret: env("PANCAKE_WEBHOOK_SECRET"),
  senderId: env("PANCAKE_SENDER_ID"),
});

export const agent = defineAgent({
  name: "pancake-channel-agent",
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
  // Human handoff: drop messages on conversations staff tagged in Pancake. Hooks run in an
  // isolate and must be self-contained, so the tag ids are inlined, not read from env.
  hooks: {
    onMessageReceived: (ctx, event) => {
      if (event.channel !== "pancake") return undefined;
      const handoffTagIds = new Set(["order-tag", "pending-tag"]);
      const tagIds = event.source.tagIds ?? [];

      return tagIds.some((tagId) => handoffTagIds.has(tagId))
        ? { drop: true }
        : undefined;
    },
  },
  connections: [pancake],
});
