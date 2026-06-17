import { defineAgent, defineSandbox, env } from "filthy-panty";

// A stateless, bash-only sandbox, fresh ephemeral container per call.
export const statelessSandbox = defineSandbox({
  name: "stateless-sandbox",
  config: {
    provider: "lambda",
    network: { mode: "deny-all" },
    permissionMode: "bypass",
    timeout: 60,
  },
});

export const myAgent = defineAgent({
  name: "my-agent",
  config: {
    provider: {
      minimax: { apiKey: env.MINIMAX_API_KEY },
    },
    model: {
      provider: "minimax",
      modelId: "MiniMax-M3",
      providerOptions: {
        anthropic: {
          thinking: { type: "enabled", budgetTokens: 2000 },
        },
      },
    },
    agent: {
      system: "You are a helpful assistant. You can use bash commands to write files and run code in a sandboxed environment. Always use the tools provided to interact with the sandbox, and never assume you have direct access to the filesystem or execution environment.",
    },
    sandbox: statelessSandbox,
  },
});
