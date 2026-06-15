import { defineAgent, defineSandbox, defineWorkspace, env } from "filthy-panty";

export const sandbox = defineSandbox("sandbox", {
  provider: "lambda",
  network: { mode: "allow-all" },
  permissionMode: "bypass",
  timeout: 60,
  envVars: {
    SANDBOX_SMOKE_VAR: env.SANDBOX_SMOKE_VAR,
  },
});

export const workspace = defineWorkspace("workspace", {
  storage: { provider: "s3" },
  harness: { enabled: true },
});

export const sandboxAgent = defineAgent("sandbox-agent", {
  provider: {
    google: {
      apiKey: env.GOOGLE_API_KEY
    },
  },
  model: {
    provider: "google",
    modelId: "gemma-4-31b-it",
  },
  agent: {
    system: "You are testing the workspace sandbox.",
  },
  sandbox: sandbox,
  workspaces: [workspace],
});
