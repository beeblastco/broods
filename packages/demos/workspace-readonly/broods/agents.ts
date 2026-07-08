import { defineAgent, defineSandbox, defineWorkspace, env } from "broods";

export const writerSandbox = defineSandbox({
  name: "writer-sandbox",
  config: {
    provider: "lambda",
    permissionMode: "bypass",
  },
});

export const sharedWorkspace = defineWorkspace({
  name: "shared",
  description: "Shared workspace read by sandbox-less agents",
  config: {
    storage: { provider: "s3" },
  },
});

export const writer = defineAgent({
  name: "writer",
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
    sandbox: writerSandbox,
    workspaces: [sharedWorkspace],
    publicAccess: true,
  },
});

export const readerMount = defineAgent({
  name: "reader-mount",
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
    workspaces: [sharedWorkspace],
    publicAccess: true,
  },
});

export const readerS3 = defineAgent({
  name: "reader-s3",
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
    workspaces: [{ workspace: sharedWorkspace, sandbox: null }],
    publicAccess: true,
  },
});
