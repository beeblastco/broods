import { defineAgent, env } from "broods";

// Each hook runs in the V8 isolate; its return is typed to what that event may change.
export const hookedAgent = defineAgent({
  name: "hooked-agent",
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
    system: "You are a helpful assistant. Answer concisely.",
  },
  hooks: {
    // The returned system is appended to the prompt: return only the addition, not event.system.
    onStart: () => ({
      system: "IMPORTANT: End every response with a single 🐝 emoji.",
    }),
  },
  publicAccess: true,
});
