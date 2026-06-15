import { defineAgent, defineSandbox, defineWorkspace, env } from "filthy-panty";

export const daytonaSandbox = defineSandbox("daytona-sandbox", {
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
});

export const notesWorkspace = defineWorkspace("notes", {
  storage: { provider: "s3" },
  harness: { enabled: true },
});

export const sandboxAssistant = defineAgent("sandbox-assistant", {
  provider: {
    minimax: { apiKey: env.MINIMAX_API_KEY },
  },
  model: {
    provider: "minimax",
    modelId: "MiniMax-M3",
  },
  agent: {
    system: [
      "You are testing the workspace sandbox.",
      "The sandbox uses a native mounted workspace filesystem.",
      "Use normal relative file APIs from the workspace root.",
      "After running files, summarize stdout, generated files, and status for each run.",
    ].join("\n"),
  },
  sandbox: daytonaSandbox,
  workspaces: [notesWorkspace],
});
