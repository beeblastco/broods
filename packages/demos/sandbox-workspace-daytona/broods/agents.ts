import { defineAgent, defineSandbox, defineWorkspace, env } from "broods";

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
      system: "You are a helpful assistant that can call tools and provide information to the user.",
    },
    sandbox: daytonaSandbox,
    workspaces: [notesWorkspace],
    publicAccess: true,
  },
});
