import { defineAgent, defineSandbox, env } from "broods";

// A stateless, bash-only self-hosted sandbox (workdir `sandbox` provider): a fresh
// ephemeral container per call, with internet egress and a config env var injected.
export const statelessSandbox = defineSandbox({
  name: "stateless-sandbox",
  config: {
    provider: "sandbox",
    network: { mode: "allow-all" },
    permissionMode: "bypass",
    timeout: 60,
    envVars: { DEMO_GREETING: "hello-from-config" },
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
    },
    agent: {
      system:
        "You are a helpful assistant. Use bash to write files and run code in a sandboxed Linux environment. Always use the provided tools to interact with the sandbox, and never assume direct access to the filesystem or execution environment.",
    },
    sandbox: statelessSandbox,
    publicAccess: true,
  },
});
