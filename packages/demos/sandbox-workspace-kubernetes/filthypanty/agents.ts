import { defineAgent, defineSandbox, defineWorkspace, env } from "filthy-panty";

export const k8sSandbox = defineSandbox("k8s-sandbox", {
  provider: "kubernetes",
  network: { mode: "allow-all" },
  permissionMode: "bypass",
  timeout: 60,
  outputLimitBytes: 65536,
  envVars: {
    API_BASE_URL: "https://jsonplaceholder.typicode.com",
    SANDBOX_SMOKE_VAR: "sandbox-env-ok",
  },
  options: {
    mountAwsS3Buckets: true,
    workspaceRoot: "/mnt/workspaces",
  },
});

export const notesWorkspace = defineWorkspace("notes", {
  storage: { provider: "s3" },
  harness: { enabled: true },
});

export const analysisAgent = defineAgent("analysis-agent", {
  provider: {
    minimax: { apiKey: env.MINIMAX_API_KEY },
  },
  model: {
    provider: "minimax",
    modelId: "MiniMax-M3",
  },
  agent: {
    system: [
      "You are the first independent agent in a Kubernetes S3-backed workspace sandbox test.",
      "Create API analysis artifacts in the shared workspace.",
      "Follow the user's numbered steps closely.",
      "When a numbered step asks for a bash call, use bash only for that step.",
    ].join(" "),
  },
  sandbox: k8sSandbox,
  workspaces: [notesWorkspace],
}, { description: "Fetches API data and writes analysis artifacts" });

export const visualizationAgent = defineAgent("visualization-agent", {
  provider: {
    minimax: { apiKey: env.MINIMAX_API_KEY },
  },
  model: {
    provider: "minimax",
    modelId: "MiniMax-M3",
  },
  agent: {
    system: [
      "You are the second independent agent in a Kubernetes S3-backed workspace sandbox test.",
      "Read analysis artifacts created by another agent from the shared workspace as part of the first numbered bash call.",
      "Build small dependency-free scripts with Python standard library only.",
      "Do not install packages. Do not use matplotlib. Generate SVG/HTML/JSON outputs directly.",
      "The analysis schema is top_5_users entries with name, completed, total, and rate fields; rate is a 0..1 ratio.",
      "Follow the user's numbered steps closely.",
      "Do not run preflight commands outside the numbered steps.",
      "When a numbered step asks for a bash call, use bash only for that step.",
    ].join(" "),
  },
  sandbox: k8sSandbox,
  workspaces: [notesWorkspace],
}, { description: "Reads analysis artifacts and writes visualization artifacts" });
