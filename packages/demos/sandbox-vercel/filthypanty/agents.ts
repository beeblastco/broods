import { defineAgent, defineSandbox, defineWorkspace, env } from "filthy-panty";

export const vercelSandbox = defineSandbox({
  name: "vercel-sandbox",
  config: {
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
  },
});

export const vercelAgent = defineAgent({
  name: "vercel-agent",
  config: {
    provider: {
      minimax: { apiKey: env.MINIMAX_API_KEY },
    },
    model: {
      provider: "minimax",
      modelId: "MiniMax-M3",
    },
    agent: {
      system: "You are a helpful assistant that can call tools and provide information to the user.",
    },
    sandbox: vercelSandbox,
  },
});
