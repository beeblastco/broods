import { defineAgent, env } from "broods";

// Hooks are declared inline, Vercel-AI-SDK-callback style. Each handler runs in
// the V8 isolate at its lifecycle point, receives (ctx, event), and its return
// is strictly typed to what that event may mutate. Here onStart injects a system
// instruction before the model runs — the SDK uploads the handler for you.
export const hookedAgent = defineAgent({
  name: "hooked-agent",
  config: {
    provider: {
      custom: {
        apiKey: env.AI_API_KEY,
        base_url: env.AI_BASE_URL,
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
      onStart: (ctx, event) => ({
        system: `${event.system}\n\nIMPORTANT: End every response with a single 🐝 emoji.`,
      }),
    },
    publicAccess: true,
  },
});
