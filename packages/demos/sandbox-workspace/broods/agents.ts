import { defineAgent, defineSandbox, defineWorkspace, env } from "broods";

// A workspace-backed sandbox on the self-hosted `sandbox` (workdir) provider. Compute is
// ephemeral per call, but the workspace FILES persist through the shared S3 mount, so the
// file tools (write/read/edit/glob/grep) operate on a real, durable project checkout.
export const workspaceSandbox = defineSandbox({
  name: "workspace-sandbox",
  config: {
    provider: "sandbox",
    network: { mode: "allow-all" },
    permissionMode: "bypass",
    timeout: 120,
    options: {
      mountAwsS3Buckets: true,
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

export const myAgent = defineAgent({
  name: "my-agent",
  config: {
    provider: {
      minimax: { apiKey: env.MINIMAX_API_KEY },
    },
    model: {
      provider: "minimax",
      modelId: "MiniMax-M3",
    },
    agent: {
      system: [
        "You are testing a workspace-backed self-hosted sandbox.",
        "Use the file tools (write/read/edit/glob/grep) with workspace-relative paths,",
        "and bash to run code. Files you write persist in the workspace across calls.",
        "Use a SEPARATE bash or file-tool call for each numbered step.",
      ].join(" "),
    },
    sandbox: workspaceSandbox,
    workspaces: [projectWorkspace],
    publicAccess: true,
  },
});
