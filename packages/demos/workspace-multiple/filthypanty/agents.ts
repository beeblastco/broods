import { defineAgent, defineSandbox, defineWorkspace, env } from "filthy-panty";

export const lambdaSandbox = defineSandbox("lambda-sandbox", {
  provider: "lambda",
  permissionMode: "bypass",
  timeout: 30,
  outputLimitBytes: 65536,
  network: { mode: "deny-all" },
});

export const personalWorkspace = defineWorkspace("personal", {
  storage: { provider: "s3" },
}, { description: "Agent notes workspace" });

export const teamWorkspace = defineWorkspace("team", {
  storage: { provider: "s3" },
}, { description: "Shared team workspace" });

export const multiWorkspaceAgent = defineAgent("multi-workspace-agent", {
  provider: {
    google: { apiKey: env.GOOGLE_API_KEY },
  },
  model: {
    provider: "google",
    modelId: "gemma-4-31b-it",
    temperature: 0,
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
  sandbox: lambdaSandbox,
  workspaces: [personalWorkspace, teamWorkspace],
});
