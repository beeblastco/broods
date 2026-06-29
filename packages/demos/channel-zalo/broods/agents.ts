import { defineAgent, defineZaloChannel, env } from "broods";

export const zalo = defineZaloChannel({
  botToken: env.ZALO_BOT_TOKEN,
  webhookSecret: env.ZALO_WEBHOOK_SECRET,
  allowedUserIds: process.env.ZALO_ALLOWED_USER_IDS?.split(",").map((value) => value.trim()).filter(Boolean) ?? [],
});

export const agent = defineAgent({
  name: "zalo-channel-agent",
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
    channels: [zalo],
  },
});
