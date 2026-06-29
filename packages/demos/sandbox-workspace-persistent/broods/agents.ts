import { defineAgent, defineSandbox, defineWorkspace, env } from "broods";

export const reservedSandbox = defineSandbox({
  name: "reserved",
  config: {
    provider: "sandbox",
    // Predefined compute size (tiny | xsmall | small | medium | large). xsmall is
    // the free default; omit `size` to keep the cheap default-create path.
    size: "small",
    // Pin a prebuilt image/snapshot to boot from (workdir image id/name, MicroVM
    // image ARN). Omit to boot the provider's default base image.
    // snapshot: "img_curated_python",
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
      // workspaceRoot: "/mnt/workspaces",
    },
  },
});

export const projectWorkspace = defineWorkspace({
  name: "project",
  config: {
    storage: { provider: "s3" },
    harness: { enabled: true },
  },
});

export const reservedAgent = defineAgent({
  name: "reserved-agent",
  config: {
    provider: {
      minimax: {
        apiKey: env.MINIMAX_API_KEY
      },
    },
    model: {
      provider: "minimax",
      modelId: "MiniMax-M3",
    },
    agent: {
      system: [
        "You are testing a reserved (persistent) self-hosted coding sandbox.",
        "Install Python packages into a virtualenv under $HOME so they persist across calls.",
        "Use a SEPARATE bash call for each numbered step.",
        "For long-running work, use bash with background:true and then poll async_status.",
      ].join(" "),
    },
    sandbox: reservedSandbox,
    workspaces: [projectWorkspace],
    publicAccess: true,
  },
});
