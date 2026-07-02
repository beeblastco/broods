import { defineAgent, definePolicy, defineSandbox, env } from "broods";

const system = [
  "You are validating Broods agent policy behavior.",
  "When the user asks for the policy smoke test, call the bash tool exactly once with the requested command.",
  "After the tool outcome, summarize whether the tool ran or was blocked.",
].join(" ")

export const lambdaSandbox = defineSandbox({
  name: "lambda-policy-sandbox",
  config: {
    provider: "lambda",
    network: { mode: "allow-all" },
    permissionMode: "bypass",
    timeout: 60,
  },
});

export const denyBashPolicy = definePolicy({
  name: "deny-bash-exec",
  description: "Deny the policy smoke-test bash command so audit and enforce rollout modes can be compared.",
  config: {
    rules: [
      {
        id: "deny-policy-smoke-command",
        effect: "deny",
        actions: ["workspace.exec"],
        resources: { toolNames: ["bash"] },
        conditions: [
          {
            attribute: "tool.input.command",
            operator: "contains",
            value: "POLICY_SMOKE_OK",
          },
        ],
      },
      {
        id: "allow-other-bash-commands",
        effect: "allow",
        actions: ["workspace.exec"],
        resources: { toolNames: ["bash"] },
      },
    ],
  },
});

export const auditPolicyAgent = defineAgent({
  name: "audit-policy-agent",
  config: {
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
      system: system
    },
    sandbox: lambdaSandbox,
    publicAccess: true,
    policy: {
      mode: "audit",
      policies: [denyBashPolicy],
    },
  },
});

export const enforcePolicyAgent = defineAgent({
  name: "enforce-policy-agent",
  config: {
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
      system: system,
    },
    sandbox: lambdaSandbox,
    publicAccess: true,
    policy: {
      mode: "enforce",
      policies: [denyBashPolicy],
    },
  },
});
