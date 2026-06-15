import { defineAgent, defineSandbox, defineWorkspace, env } from "filthy-panty";

export const defaultSandbox = defineSandbox("default-sandbox", {
  provider: "lambda",
  network: { mode: "allow-all" },
  permissionMode: "bypass",
  timeout: 60,
});

export const secureSandbox = defineSandbox("secure-sandbox", {
  provider: "lambda",
  network: { mode: "deny-all" },
  permissionMode: "bypass",
  timeout: 60,
});

export const scratchWorkspace = defineWorkspace("scratch", {
  storage: { provider: "s3" },
}, { description: "Inherits the agent default sandbox" });

export const secureWorkspace = defineWorkspace("secure", {
  storage: { provider: "s3" },
}, { description: "Pinned to the deny-all network sandbox" });

export const referenceWorkspace = defineWorkspace("reference", {
  storage: { provider: "s3" },
}, { description: "Forced read-only via sandbox: null" });

export const overrideAgent = defineAgent("override-agent", {
  provider: {
    minimax: { apiKey: env.MINIMAX_API_KEY },
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
    scratchWorkspace,
    { workspace: secureWorkspace, sandbox: secureSandbox },
    { workspace: referenceWorkspace, sandbox: null },
  ],
});
