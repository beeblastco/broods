import { defineAgent, env } from "filthy-panty";

export const cronAgent = defineAgent("cron-agent", {
  provider: {
    google: { apiKey: env.GOOGLE_API_KEY },
  },
  model: {
    provider: "google",
    modelId: "gemma-4-31b-it",
  },
  agent: {
    system: "You are a concise scheduled maintenance assistant.",
  },
});
