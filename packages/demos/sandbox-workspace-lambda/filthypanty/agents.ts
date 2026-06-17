import { defineAgent, defineSandbox, defineWorkspace, env } from "filthy-panty";

export const sandbox = defineSandbox({
  name: "sandbox",
  config: {
    provider: "lambda",
    network: { mode: "allow-all" },
    permissionMode: "bypass",
    timeout: 60,
    envVars: {
      SANDBOX_SMOKE_VAR: env.SANDBOX_SMOKE_VAR,
    },
  },
});

export const workspace = defineWorkspace({
  name: "workspace",
  config: {
    storage: { provider: "s3" },
    harness: { enabled: true },
  },
});

export const sandboxAgent = defineAgent({
  name: "sandbox-agent",
  config: {
    provider: {
      minimax: {
        apiKey: env.MINIMAX_API_KEY
      },
    },
    model: {
      provider: "minimax",
      modelId: "MiniMax-M3",
    },
    agent: {
      system: "You are testing the workspace sandbox.",
    },
    sandbox: sandbox,
    workspaces: [workspace],
  },
});
