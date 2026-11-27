import { defineAgent, defineSandbox, env } from "broods";

// The self-hosted workdir provider: a fresh ephemeral container per call.
export const statelessSandbox = defineSandbox({
  name: "stateless-sandbox",
  provider: "sandbox",
  network: { mode: "allow-all" },
  permissionMode: "bypass",
  timeout: 60,
  envVars: { DEMO_GREETING: "hello-from-config" },
});

export const myAgent = defineAgent({
  name: "my-agent",
  provider: {
    bedrock: {
      region: "us-east-1",
      apiKey: env("BEDROCK_API_KEY"),
    },
  },
  model: {
    provider: "bedrock",
    modelId: "minimax.minimax-m2.5",
  },
  agent: {
    system:
      "You are a helpful assistant. Use bash to write files and run code in a sandboxed Linux environment. Always use the provided tools to interact with the sandbox, and never assume direct access to the filesystem or execution environment.",
  },
  sandboxes: [statelessSandbox],
  publicAccess: true,
});
