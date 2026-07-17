import { defineAgent, defineSandbox, defineWorkspace, env } from "broods";

export const sandbox = defineSandbox({
  name: "sandbox",
  config: {
    provider: "lambda",
    network: { mode: "allow-all" },
    permissionMode: "bypass",
    persistent: true,
    timeout: 60,
    envVars: {
      SANDBOX_SMOKE_VAR: env("SANDBOX_SMOKE_VAR"),
    },
  },
});

export const workspace = defineWorkspace({
  name: "workspace",
  config: {
    storage: { provider: "s3" },
    harness: { guidance: { enabled: true } },
  },
});

export const sandboxAgent = defineAgent({
  name: "sandbox-agent",
  config: {
    provider: {
      google: {
        apiKey: env("GOOGLE_API_KEY"),
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
    publicAccess: true,
  },
});
