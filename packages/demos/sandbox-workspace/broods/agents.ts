import { defineAgent, defineSandbox, defineWorkspace, env } from "broods";

// Workdir provider: compute is ephemeral per call, files persist through the shared S3 mount.
export const workspaceSandbox = defineSandbox({
  name: "workspace-sandbox",
  provider: "sandbox",
  network: { mode: "allow-all" },
  permissionMode: "bypass",
  timeout: 120,
  options: {
    mountAwsS3Buckets: true,
  },
});

export const projectWorkspace = defineWorkspace({
  name: "project",
  storage: { provider: "s3" },
});

export const myAgent = defineAgent({
  name: "my-agent",
  provider: {
    google: { apiKey: env("GOOGLE_API_KEY") },
  },
  model: {
    provider: "google",
    modelId: "gemma-4-31b-it",
  },
  agent: {
    system: [
      "You are testing a workspace-backed self-hosted sandbox.",
      "Use the file tools (write/read/edit/glob/grep) with workspace-relative paths,",
      "and bash to run code. Files you write persist in the workspace across calls.",
      "Use a SEPARATE bash or file-tool call for each numbered step.",
    ].join(" "),
  },
  sandboxes: [workspaceSandbox],
  workspaces: [projectWorkspace],
  publicAccess: true,
});
