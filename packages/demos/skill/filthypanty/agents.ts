import { defineAgent, defineSkill, env } from "filthy-panty";

export const greetingSkill = defineSkill({
  name: "greeting-skill",
  config: {
    path: "greeting-skill",
  },
});

export const skillAgent = defineAgent({
  name: "skill-agent",
  config: {
    provider: {
      google: { apiKey: env.GOOGLE_API_KEY },
    },
    model: {
      provider: "google",
      modelId: "gemma-4-31b-it",
    },
    agent: {
      system: "You are a concise assistant.",
    },
    skills: {
      enabled: true,
      allowed: [greetingSkill],
    },
  },
});
