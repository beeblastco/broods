import { defineAgent, defineSandbox, env } from "broods";

export const runner = defineSandbox({
  name: "harness-codex-runner",
  provider: "sandbox",
  persistent: true,
  permissionMode: "bypass",
  network: { mode: "allow-all" },
});

export const codingAgent = defineAgent({
  name: "harness-codex",
  harness: {
    kind: "codex",
    permissionMode: "allow-all",
    startupTimeoutMs: 180_000,
  },
  sandbox: runner,
  provider: {
    custom: {
      apiKey: env("AI_API_KEY"),
      base_url: env("AI_BASE_URL"),
    },
  },
  model: {
    provider: "custom",
    modelId: "Qwen3.6-27B",
    reasoning: "medium",
  },
  agent: {
    system:
      "You are a coding agent. Inspect and edit files in your sandbox when useful.",
  },
  publicAccess: true,
});
