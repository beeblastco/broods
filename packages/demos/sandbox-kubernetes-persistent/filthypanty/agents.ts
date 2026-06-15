import { defineAgent, defineSandbox, defineWorkspace, env } from "filthy-panty";

export const k8sReservedSandbox = defineSandbox("k8s-reserved", {
  provider: "kubernetes",
  network: { mode: "allow-all" },
  permissionMode: "bypass",
  persistent: true,
  lifecycle: {
    idleTimeoutSeconds: 300,
  },
  timeout: 120,
  outputLimitBytes: 65536,
  options: {
    mountAwsS3Buckets: true,
    workspaceRoot: "/mnt/workspaces",
    persistentDiskGb: 20,
    persistentHome: "/home/node",
  },
});

export const projectWorkspace = defineWorkspace("project", {
  storage: { provider: "s3" },
  harness: { enabled: true },
});

export const reservedAgent = defineAgent("reserved-agent", {
  provider: {
    minimax: { apiKey: env.MINIMAX_API_KEY },
  },
  model: {
    provider: "minimax",
    modelId: "MiniMax-M3",
  },
  agent: {
    system: [
      "You are testing a reserved (persistent) Kubernetes coding sandbox.",
      "Install Python packages into a virtualenv under $HOME so they persist across calls.",
      "Use a SEPARATE bash call for each numbered step.",
      "For long-running work, use bash with background:true and then poll async_status.",
    ].join(" "),
  },
  sandbox: k8sReservedSandbox,
  workspaces: [projectWorkspace],
});
