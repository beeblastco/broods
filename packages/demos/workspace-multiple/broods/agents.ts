import { defineAgent, defineSandbox, defineWorkspace, env } from "broods";

export const lambdaSandbox = defineSandbox({
  name: "lambda-sandbox",
  config: {
    provider: "lambda",
    permissionMode: "bypass",
    timeout: 30,
    outputLimitBytes: 65536,
    network: { mode: "deny-all" },
  },
});

export const personalWorkspace = defineWorkspace({
  name: "personal",
  description: "Agent notes workspace",
  config: {
    storage: { provider: "s3" },
  },
});

export const teamWorkspace = defineWorkspace({
  name: "team",
  description: "Shared team workspace",
  config: {
    storage: { provider: "s3" },
  },
});

export const multiWorkspaceAgent = defineAgent({
  name: "multi-workspace-agent",
  config: {
    provider: {
      custom: {
        apiKey: env.AI_API_KEY,
        base_url: env.AI_BASE_URL,
      },
    },
    model: {
      provider: "custom",
      modelId: "Qwen3.6-27B",
    },
    agent: {
      system: [
        "You are testing named workspaces.",
        "Use the bash tool for every filesystem check.",
        "Use the default personal workspace for notes.",
        "Use the team workspace when the user asks for shared team files.",
        "Report any bash tool error exactly.",
      ].join("\n"),
    },
    workspaces: [
      { workspace: personalWorkspace, sandbox: lambdaSandbox },
      { workspace: teamWorkspace, sandbox: null },
    ],
    publicAccess: true,
  },
});
