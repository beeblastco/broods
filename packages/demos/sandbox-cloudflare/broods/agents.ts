import { defineAgent, defineSandbox, env } from "broods";

export const cloudflareSandbox = defineSandbox({
  name: "cloudflare-sandbox",
  provider: "cloudflare",
  persistent: true,
  size: "small",
  network: { mode: "allow-all" },
  permissionMode: "bypass",
  timeout: 120,
  outputLimitBytes: 65536,
  lifecycle: { idleTimeoutSeconds: 600 },
  envVars: {
    SANDBOX_SMOKE_VAR: env("SANDBOX_SMOKE_VAR"),
  },
});

export const cloudflareAgent = defineAgent({
  name: "cloudflare-agent",
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
    system:
      "You are a helpful assistant with access to a sandbox environment where you can run code and access the internet. Use the tools available to you to answer the user's question.",
  },
  sandboxes: [cloudflareSandbox],
  publicAccess: true,
});
