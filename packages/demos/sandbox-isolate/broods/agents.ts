import { defineAgent, defineSandbox, env } from "broods";

export const isolateSandbox = defineSandbox({
  name: "isolate-sandbox",
  provider: "isolate",
  persistent: true,
  network: { mode: "allow-all" },
  permissionMode: "bypass",
  timeout: 30,
  outputLimitBytes: 65536,
  envVars: {
    SANDBOX_SMOKE_VAR: env("SANDBOX_SMOKE_VAR"),
  },
});

export const isolateAgent = defineAgent({
  name: "isolate-agent",
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
      "You are a helpful assistant with a bash sandbox of built-in text tools (grep, sed, awk, jq, sort, curl) and no python or node. Use the tools available to you to answer the user's question.",
  },
  sandboxes: [isolateSandbox],
  publicAccess: true,
});
