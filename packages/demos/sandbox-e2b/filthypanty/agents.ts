import { defineAgent, defineSandbox, env } from "filthy-panty";

export const e2bSandbox = defineSandbox("e2b-sandbox", {
  provider: "e2b",
  network: { mode: "allow-all" },
  permissionMode: "bypass",
  timeout: 120,
  outputLimitBytes: 65536,
  envVars: {
    SANDBOX_SMOKE_VAR: "sandbox-env-ok",
  },
  options: {
    apiKey: env.E2B_API_KEY,
    template: env.E2B_TEMPLATE,
    workspaceRoot: "/mnt/workspaces",
  },
});

export const e2bAgent = defineAgent("e2b-agent", {
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
      "You only have the bash tool — E2B does not mount a persistent workspace.",
      "Write any files and run them in the SAME bash command.",
      "Report stdout and status for every run.",
    ].join("\n"),
  },
  sandbox: e2bSandbox,
});
