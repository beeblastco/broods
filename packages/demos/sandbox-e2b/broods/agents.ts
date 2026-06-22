import { defineAgent, defineSandbox, env } from "broods";

export const e2bSandbox = defineSandbox({
  name: "e2b-sandbox",
  config: {
    provider: "e2b",
    network: { mode: "allow-all" },
    permissionMode: "bypass",
    timeout: 120,
    outputLimitBytes: 65536,
    envVars: {
      SANDBOX_SMOKE_VAR: env.SANDBOX_SMOKE_VAR,
    },
    options: {
      apiKey: env.E2B_API_KEY,
      // template: env.E2B_TEMPLATE,
    },
  },
});

export const e2bAgent = defineAgent({
  name: "e2b-agent",
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
      system: "You are a helpful assistant with access to a sandbox environment where you can run code and access the internet. Use the tools available to you to answer the user's question.",
    },
    sandbox: e2bSandbox,
    publicAccess: true,
  },
});
