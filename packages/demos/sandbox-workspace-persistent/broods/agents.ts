import { defineAgent, defineSandbox, defineWorkspace, env } from "broods";

export const reservedSandbox = defineSandbox({
  name: "reserved",
  provider: "sandbox",
  // tiny | xsmall | small | medium | large; omit for the free xsmall default.
  size: "small",
  // Optional: snapshot: "img_curated_python" boots a workdir image or MicroVM image ARN.
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
  },
});

export const projectWorkspace = defineWorkspace({
  name: "project",
  storage: { provider: "s3" },
});

export const reservedAgent = defineAgent({
  name: "reserved-agent",
  provider: {
    bedrock: {
      region: "us-east-1",
      apiKey: env("BEDROCK_API_KEY"),
    },
  },
  model: {
    provider: "bedrock",
    modelId: "minimax.minimax-m2.5",
  },
  agent: {
    system: [
      "You are testing a reserved (persistent) self-hosted coding sandbox.",
      "Install Python packages into a virtualenv under $HOME so they persist across calls.",
      "Use a SEPARATE bash call for each numbered step.",
      "For long-running work, use bash with background:true and then poll async_status.",
    ].join(" "),
  },
  sandboxes: [reservedSandbox],
  workspaces: [projectWorkspace],
  publicAccess: true,
});
