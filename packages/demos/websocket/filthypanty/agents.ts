import { defineAgent, env } from "filthy-panty";

export const chat = defineAgent("websocket-chat", {
  provider: {
    google: { apiKey: env.GOOGLE_API_KEY },
  },
  model: {
    provider: "google",
    modelId: "gemma-4-31b-it",
  },
  agent: {
    system: "You are a concise websocket demo assistant.",
  },
});
