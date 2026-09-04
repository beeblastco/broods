import { defineAgent, env } from "broods";

// The onboarding shape: one agent on a custom provider, secrets by env ref.
export const search = defineAgent({
  name: "search",
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
  publicAccess: true,
});

// A second agent so the compile walks more than one resource, with a session
// policy and a channel the way a deployed project carries them.
export const oncall = defineAgent({
  name: "oncall",
  provider: {
    custom: {
      apiKey: env("AI_API_KEY"),
      base_url: env("AI_BASE_URL"),
    },
  },
  model: {
    provider: "custom",
    modelId: "Qwen3.6-27B",
    temperature: 0.2,
  },
  agent: {
    system:
      "You are the on-call assistant. Be brief and cite the runbook section you used.",
    maxTurn: 12,
  },
  session: {
    pruning: { enabled: true },
    compaction: { enabled: true, maxContextLength: 80_000 },
  },
});
