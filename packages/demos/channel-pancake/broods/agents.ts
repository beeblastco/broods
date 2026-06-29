import { defineAgent, definePancakeChannel, env } from "broods";

// Pancake channel supports an optional `ignoreTagIds` parameter which allows you to specify a list of tag IDs. 
// If a message contains any of these tags, the agent will ignore the message and not respond to it. 
// This can be useful for filtering out certain types of messages or for preventing the agent from responding to messages that are not relevant to its purpose.
const ignoreTagIds: string[] = (env.PANCAKE_IGNORE_TAG_IDS as string | undefined)?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];

export const pancake = definePancakeChannel({
  pageId: env.PANCAKE_PAGE_ID,
  pageAccessToken: env.PANCAKE_PAGE_ACCESS_TOKEN,
  webhookSecret: env.PANCAKE_WEBHOOK_SECRET,
  senderId: env.PANCAKE_SENDER_ID,
  ...(ignoreTagIds.length > 0 ? { ignoreTagIds } : {}),
});

export const agent = defineAgent({
  name: "pancake-channel-agent",
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
    channels: [pancake],
  },
});
