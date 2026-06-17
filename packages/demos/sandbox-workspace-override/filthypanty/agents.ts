import { defineAgent, defineSandbox, defineWorkspace, env } from "filthy-panty";

export const defaultSandbox = defineSandbox({
  name: "default-sandbox",
  config: {
    provider: "lambda",
    network: { mode: "allow-all" },
    permissionMode: "bypass",
    timeout: 60,
  },
});

export const secureSandbox = defineSandbox({
  name: "secure-sandbox",
  config: {
    provider: "lambda",
    network: { mode: "deny-all" },
    permissionMode: "bypass",
    timeout: 60,
  },
});

export const scratchWorkspace = defineWorkspace({
  name: "scratch",
  description: "Inherits the agent default sandbox",
  config: {
    storage: { provider: "s3" },
  },
});

export const secureWorkspace = defineWorkspace({
  name: "secure",
  description: "Pinned to the deny-all network sandbox",
  config: {
    storage: { provider: "s3" },
  },
});

export const referenceWorkspace = defineWorkspace({
  name: "reference",
  description: "Forced read-only via sandbox: null",
  config: {
    storage: { provider: "s3" },
  },
});

export const overrideAgent = defineAgent({
  name: "override-agent",
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
    agent: {
      system: [
        "You have three workspaces with different sandbox bindings.",
        "scratch: full read/write via the default sandbox.",
        "secure: full read/write via a deny-all network sandbox.",
        "reference: read-only (read/glob only) — write/edit are not available there.",
        "Always pass the matching `workspace` name to each file tool. Report errors verbatim.",
      ].join("\n"),
    },
    sandbox: defaultSandbox,
    workspaces: [
      { workspace: scratchWorkspace },
      { workspace: secureWorkspace, sandbox: secureSandbox },
      { workspace: referenceWorkspace, sandbox: null },
    ],
  },
});
