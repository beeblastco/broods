import { defineAgent, defineSandbox, defineWorkspace, env } from "filthy-panty";

export const vercelSandbox = defineSandbox("vercel-sandbox", {
  provider: "vercel",
  persistent: true,
  network: {
    mode: "restricted",
    allowDomains: ["api.github.com", "registry.npmjs.org"],
  },
  permissionMode: "bypass",
  timeout: 120,
  outputLimitBytes: 65536,
  envVars: {
    SANDBOX_SMOKE_VAR: "sandbox-env-ok",
  },
  onCreate: [
    "printf 'created\\n' > .fp-vercel-hook.txt",
  ],
  onResume: [
    "printf 'resumed\\n' >> .fp-vercel-hook.txt",
  ],
  options: {
    token: env.VERCEL_TOKEN,
    teamId: env.VERCEL_TEAM_ID,
    projectId: env.VERCEL_PROJECT_ID,
    runtime: "node24",
    workspaceRoot: "/mnt/workspaces",
  },
});

export const vercelWorkspace = defineWorkspace("vercel-project", {
  storage: { provider: "vercel" },
  harness: { enabled: true },
});

export const vercelAgent = defineAgent("vercel-agent", {
  provider: {
    minimax: { apiKey: env.MINIMAX_API_KEY },
  },
  model: {
    provider: "minimax",
    modelId: "MiniMax-M3",
  },
  agent: {
    system: [
      "You are testing a persistent Vercel Sandbox.",
      "Use the bash tool for each numbered step.",
      "Report stdout and status for every run.",
    ].join("\n"),
  },
  sandbox: vercelSandbox,
  workspaces: [vercelWorkspace],
});
