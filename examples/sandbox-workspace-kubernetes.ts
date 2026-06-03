/**
 * Example: workspace sandbox execution on the Beeblast k3s cluster via the
 * `kubernetes` provider (agent-sandbox runtime pods).
 */

import {
  createAccount,
  createAgent,
  createSandbox,
  createWorkspace,
  deleteAccount,
  streamSSE,
  requireEnv,
} from "./utils.ts";

const minimaxApiKey = requireEnv("ACCOUNT_MINIMAX_API_KEY");
const username = `sandbox-k8s-${Date.now()}`;

const account = await createAccount(username);

const sandbox = await createSandbox(account.secret, "k8s-sandbox", {
  provider: "kubernetes",
  permissionMode: "bypass",
  timeout: 60,
  outputLimitBytes: 65536,
  envVars: {
    SANDBOX_SMOKE_VAR: "sandbox-env-ok",
  },
  options: {
    // namespace/image/serviceAccountName/imagePullSecrets default from harness env.
    // mountAwsS3Buckets mounts the shared workspace S3 bucket so files persist across
    // ephemeral per-run pods (parity with lambda/daytona). Bucket comes from harness
    // env; S3 credentials come from the pod's Kubernetes service account / IRSA.
    mountAwsS3Buckets: true,
    workspaceRoot: "/mnt/workspaces",
  },
});

const workspace = await createWorkspace(account.secret, "notes", {
  storage: { provider: "s3" },
  harness: { enabled: true },
});

const agent = await createAgent(account.secret, "Kubernetes sandbox assistant", {
  provider: {
    minimax: { apiKey: minimaxApiKey },
  },
  model: {
    provider: "minimax",
    modelId: "MiniMax-M2.7",
  },
  sandbox: sandbox.sandboxId,
  workspaces: [{ name: "notes", workspaceId: workspace.workspaceId }],
});

console.log("Created test account:", JSON.stringify(account));
console.log("Created sandbox:", JSON.stringify(sandbox));
console.log("Created workspace:", JSON.stringify(workspace));
console.log("Created test agent:", JSON.stringify(agent));

try {
  const body = {
    agentId: agent.agentId,
    eventId: `sandbox-${Date.now()}`,
    conversationKey: `sandbox-${Date.now()}`,
    events: [
      {
        role: "user",
        content: [{
          type: "text",
          text: [
            "Run this kubernetes sandbox test. Use a SEPARATE bash tool call for each numbered step",
            "so we verify files persist across runs (each run is a fresh pod sharing the S3 workspace).",
            "1. echo \"shell:$SANDBOX_SMOKE_VAR\" (expect sandbox-env-ok), then create notes.txt with the",
            "   single line 'line1' and run: ls -1.",
            "2. Read notes.txt first (expect line1 — proves the file written in step 1 persisted),",
            "   then rewrite notes.txt with the two lines 'line1' and 'line2', and cat notes.txt.",
            "3. Write count.py that opens notes.txt and prints 'lines:' followed by the line count, then",
            "   run python3 count.py (expect lines:2).",
            "4. Edit count.py to also print the file's contents in uppercase, then run it again.",
            "5. Run: curl -s -o /dev/null -w '%{http_code}' https://example.com (outbound internet check).",
            "6. Run: ls -1 (expect notes.txt and count.py to still be present).",
            "7. Summarize stdout and status for every step, and confirm whether the files persisted.",
          ].join("\n"),
        }],
      },
    ],
  };

  for await (const chunk of streamSSE(body, account.secret)) {
    process.stdout.write(`${chunk}\n\n`);
  }
} finally {
  await deleteAccount(account.secret);
  console.log("\n\nDeleted test account");
}
