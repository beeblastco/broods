import { defineAgent, defineSandbox, env } from "broods";

// Listed first, so it is the agent's default machine.
export const generalSandbox = defineSandbox({
  name: "general-sandbox",
  provider: "lambda",
  network: { mode: "allow-all" },
  permissionMode: "bypass",
  timeout: 60,
});

// Picked with bash `sandbox: "offline-sandbox"`; no workspace and no egress suit untrusted code.
export const offlineSandbox = defineSandbox({
  name: "offline-sandbox",
  description: "No network access. Run untrusted code here.",
  provider: "lambda",
  network: { mode: "deny-all" },
  permissionMode: "bypass",
  timeout: 60,
});

export const multiSandboxAgent = defineAgent({
  name: "multi-sandbox-agent",
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
      "You have two sandboxes. general-sandbox is the default and reaches the internet. offline-sandbox has no network. Pick one with the bash `sandbox` argument and report errors verbatim.",
  },
  sandboxes: [generalSandbox, offlineSandbox],
  publicAccess: true,
});
