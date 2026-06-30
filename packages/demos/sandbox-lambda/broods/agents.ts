import { defineAgent, defineSandbox, env } from "broods";

// A stateless, bash-only sandbox, fresh ephemeral container per call.
export const statelessSandbox = defineSandbox({
  name: "stateless-sandbox",
  config: {
    provider: "lambda",
    network: { mode: "allow-all" },
    permissionMode: "bypass",
    timeout: 60,
  },
});

export const myAgent = defineAgent({
  name: "my-agent",
  config: {
    provider: {
      google: { apiKey: env.GOOGLE_API_KEY },
    },
    model: {
      provider: "google",
      modelId: "gemma-4-31b-it",
    },
    agent: {
      system: "You are a helpful assistant. You can use bash commands to write files and run code in a sandboxed environment. Always use the tools provided to interact with the sandbox, and never assume you have direct access to the filesystem or execution environment.",
    },
    sandbox: statelessSandbox,
    publicAccess: true,
  },
});
