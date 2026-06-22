import { defineAgent, env } from "broods";

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
      system: "You are a helpful assistant that can answer questions and provide information.",
    },
    publicAccess: true,
  },
});
