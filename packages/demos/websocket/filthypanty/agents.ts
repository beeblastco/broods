import { defineAgent, env } from "filthy-panty";

export const chat = defineAgent({
  name: "websocket-chat",
  config: {
    provider: {
      minimax: { apiKey: env.MINIMAX_API_KEY },
    },
    model: {
      provider: "minimax",
      modelId: "MiniMax-M3",
    },
    agent: {
      system: "You are a concise websocket demo assistant.",
    },
  },
});
