import { defineAgent, defineSandbox, defineWorkspace, env } from "broods";

export const writerSandbox = defineSandbox({
  name: "writer-sandbox",
  provider: "lambda",
  permissionMode: "bypass",
});

export const sharedWorkspace = defineWorkspace({
  name: "shared",
  description: "Shared workspace read by sandbox-less agents",
  storage: { provider: "s3" },
});

export const writer = defineAgent({
  name: "writer",
  provider: {
    custom: {
      apiKey: env("AI_API_KEY"),
      base_url: env("AI_BASE_URL"),
    },
  },
  model: {
    provider: "custom",
    modelId: "Qwen3.6-27B",
  },
  sandbox: writerSandbox,
  workspaces: [sharedWorkspace],
  publicAccess: true,
});

export const readerMount = defineAgent({
  name: "reader-mount",
  provider: {
    custom: {
      apiKey: env("AI_API_KEY"),
      base_url: env("AI_BASE_URL"),
    },
  },
  model: {
    provider: "custom",
    modelId: "Qwen3.6-27B",
  },
  workspaces: [sharedWorkspace],
  publicAccess: true,
});

export const readerS3 = defineAgent({
  name: "reader-s3",
  provider: {
    custom: {
      apiKey: env("AI_API_KEY"),
      base_url: env("AI_BASE_URL"),
    },
  },
  model: {
    provider: "custom",
    modelId: "Qwen3.6-27B",
  },
  workspaces: [{ workspace: sharedWorkspace, sandbox: null }],
  publicAccess: true,
});
