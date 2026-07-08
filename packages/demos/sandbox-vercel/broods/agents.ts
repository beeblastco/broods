import { defineAgent, defineSandbox, env } from "broods";

export const vercelSandbox = defineSandbox({
  name: "vercel-sandbox",
  config: {
    provider: "vercel",
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
    options: {
      token: env.VERCEL_TOKEN,
      teamId: env.VERCEL_TEAM_ID,
      projectId: env.VERCEL_PROJECT_ID,
      runtime: "node24",
    },
  },
});

export const vercelAgent = defineAgent({
  name: "vercel-agent",
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
    agent: {
      system: "You are a helpful assistant that can call tools and provide information to the user.",
    },
    sandbox: vercelSandbox,
    publicAccess: true,
  },
});
