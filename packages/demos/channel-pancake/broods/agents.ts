import { defineAgent, definePancakeChannel, env } from "broods";

export const pancake = definePancakeChannel({
  pageId: env.PANCAKE_PAGE_ID,
  pageAccessToken: env.PANCAKE_PAGE_ACCESS_TOKEN,
  webhookSecret: env.PANCAKE_WEBHOOK_SECRET,
  senderId: env.PANCAKE_SENDER_ID,
});

export const agent = defineAgent({
  name: "pancake-channel-agent",
  config: {
    provider: {
      custom: {
        apiKey: env.AI_API_KEY,
        base_url: env.AI_BASE_URL,
      }
    },
    model: {
      provider: "custom",
      modelId: "Qwen3.6-27B",
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
    // Human-handoff filter: drop inbound messages on conversations a staff member
    // has taken over (tagged in Pancake) so the agent stays quiet. This replaces
    // the old baked-in `ignoreTagIds` channel option — the same behavior, now
    // owned by you. Handlers run in an isolate and must be self-contained, so the
    // handoff tag ids are inlined rather than read from env or a closure.
    hooks: {
      onMessageReceived: (ctx, event) => {
        if (event.channel !== "pancake") return undefined;
        const handoffTagIds = ["order-tag", "pending-tag"];
        const tagIds = event.source.tagIds ?? [];

        return tagIds.some((tagId) => handoffTagIds.includes(tagId)) ? { drop: true } : undefined;
      },
    },
    channels: [pancake],
  },
});
