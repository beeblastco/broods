import { defineAgent, defineSandbox, defineWorkspace, env } from "filthy-panty";

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
      minimax: {
        apiKey: env.MINIMAX_API_KEY
      },
    },
    model: {
      provider: "minimax",
      modelId: "MiniMax-M3",
    },
    sandbox: writerSandbox,
    workspaces: [sharedWorkspace],
  },
});

export const readerMount = defineAgent({
  name: "reader-mount",
  config: {
    provider: {
      minimax: {
        apiKey: env.MINIMAX_API_KEY
      },
    },
    model: {
      provider: "minimax",
      modelId: "MiniMax-M3",
    },
    workspaces: [sharedWorkspace],
  },
});

export const readerS3 = defineAgent({
  name: "reader-s3",
  config: {
    provider: {
      minimax: {
        apiKey: env.MINIMAX_API_KEY
      },
    },
    model: {
      provider: "minimax",
      modelId: "MiniMax-M3",
    },
    workspaces: [{ workspace: sharedWorkspace, sandbox: null }],
  },
});
