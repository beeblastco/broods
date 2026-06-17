import { defineAgent, defineSandbox, defineWorkspace, env } from "filthy-panty";

export const daytonaSandbox = defineSandbox({
  name: "daytona-sandbox",
  config: {
    provider: "daytona",
    network: { mode: "allow-all" },
    permissionMode: "bypass",
    timeout: 120,
    outputLimitBytes: 65536,
    options: {
      apiKey: env.DAYTONA_API_KEY,
      organizationId: env.DAYTONA_ORGANIZATION_ID,
      apiUrl: "https://app.daytona.io/api",
      target: "eu",
      snapshot: "fuse-s3",
      workspaceRoot: "/mnt/workspaces",
      mountAwsS3Buckets: true,
    },
  },
});

export const notesWorkspace = defineWorkspace({
  name: "notes",
  config: {
    storage: { provider: "s3" },
    harness: { enabled: true },
  },
});

export const sandboxAssistant = defineAgent({
  name: "sandbox-assistant",
  config: {
    provider: {
      minimax: { apiKey: env.MINIMAX_API_KEY },
    },
    model: {
      provider: "minimax",
      modelId: "MiniMax-M3",
    },
    agent: {
      system: "You are a helpful assistant that can call tools and provide information to the user.",
    },
    sandbox: daytonaSandbox,
    workspaces: [notesWorkspace],
  },
});
