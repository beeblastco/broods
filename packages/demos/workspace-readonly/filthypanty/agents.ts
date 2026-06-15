import { defineAgent, defineSandbox, defineWorkspace, env } from "filthy-panty";

export const writerSandbox = defineSandbox("writer-sandbox", {
  provider: "lambda",
  permissionMode: "bypass",
});

export const sharedWorkspace = defineWorkspace("shared", {
  storage: { provider: "s3" },
}, { description: "Shared workspace read by sandbox-less agents" });

export const writer = defineAgent("writer", {
  provider: {
    google: { apiKey: env.GOOGLE_API_KEY },
  },
  model: {
    provider: "google",
    modelId: "gemma-4-31b-it",
    temperature: 0,
  },
  sandbox: writerSandbox,
  workspaces: [sharedWorkspace],
});

export const readerMount = defineAgent("reader-mount", {
  provider: {
    google: { apiKey: env.GOOGLE_API_KEY },
  },
  model: {
    provider: "google",
    modelId: "gemma-4-31b-it",
    temperature: 0,
  },
  workspaces: [sharedWorkspace],
});

export const readerS3 = defineAgent("reader-s3", {
  provider: {
    google: { apiKey: env.GOOGLE_API_KEY },
  },
  model: {
    provider: "google",
    modelId: "gemma-4-31b-it",
    temperature: 0,
  },
  workspaces: [{ workspace: sharedWorkspace, sandbox: null }],
});
