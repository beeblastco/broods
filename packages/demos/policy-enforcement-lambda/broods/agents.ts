import { defineAgent, definePolicy, defineSandbox, env } from "broods";

const system = [
  "You are validating Broods agent policy behavior.",
  "When the user asks for the policy smoke test, call the bash tool exactly once with the requested command.",
  "After the tool outcome, summarize whether the tool ran or was blocked.",
].join(" ");

export const lambdaSandbox = defineSandbox({
  name: "lambda-policy-sandbox",
  provider: "lambda",
  network: { mode: "allow-all" },
  permissionMode: "bypass",
  timeout: 60,
});

// Mode rides on the policy, so comparing the two rollout stages means two
// policies over one shared rule set rather than one policy read two ways.
const denySmokeCommandRules = [
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
] as const;

export const auditBashPolicy = definePolicy({
  name: "audit-bash-exec",
  description:
    "Records the policy smoke-test bash command it would have denied, without blocking it.",
  mode: "audit",
  rules: [...denySmokeCommandRules],
});

export const enforceBashPolicy = definePolicy({
  name: "deny-bash-exec",
  description: "Blocks the policy smoke-test bash command outright.",
  mode: "enforce",
  rules: [...denySmokeCommandRules],
});

export const auditPolicyAgent = defineAgent({
  name: "audit-policy-agent",
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
  policies: [auditBashPolicy],
});

export const enforcePolicyAgent = defineAgent({
  name: "enforce-policy-agent",
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
  policies: [enforceBashPolicy],
});
