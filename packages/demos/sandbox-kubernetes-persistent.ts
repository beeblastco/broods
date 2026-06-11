/**
 * Example: a reserved (persistent) Kubernetes coding sandbox.
 *
 * Demonstrates the `persistent: true` lifecycle on the `kubernetes` provider — a
 * long-lived sandbox per workspace with a home PVC (installed packages + code
 * survive scale-to-0), Fargate-style idle scale-down via the infra reaper, and a
 * detached background job observed with the auto-registered `async_status` tool.
 */

import {
  createAccount,
  createAgent,
  createSandbox,
  createWorkspace,
  deleteAccount,
  streamSSE,
  requireEnv,
} from "filthy-panty";

const minimaxApiKey = requireEnv("ACCOUNT_MINIMAX_API_KEY");
const username = `sandbox-k8s-persistent-${Date.now()}`;

const account = await createAccount(username);

const sandbox = await createSandbox(account.secret, "k8s-reserved", {
  provider: "kubernetes",
  network: { mode: "allow-all" },
  permissionMode: "bypass",
  // Reserve one long-lived sandbox per workspace and reconnect to it each call.
  persistent: true,
  lifecycle: {
    idleTimeoutSeconds: 300, // reaper scales to 0 after 5 min idle (no running job)
  },
  timeout: 120,
  outputLimitBytes: 65536,
  options: {
    // S3 = shared/durable workspace files; the home PVC = the coding env where
    // pip/npm/uv installs and venvs persist across a scale-to-0.
    mountAwsS3Buckets: true,
    workspaceRoot: "/mnt/workspaces",
    persistentDiskGb: 20,
    persistentHome: "/home/node",
  },
});

const workspace = await createWorkspace(account.secret, "project", {
  storage: { provider: "s3" },
  harness: { enabled: true },
});

const agent = await createAgent(account.secret, "Reserved Kubernetes coding sandbox", {
  provider: {
    minimax: { apiKey: minimaxApiKey },
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
  sandbox: sandbox.sandboxId,
  workspaces: [{ name: "project", workspaceId: workspace.workspaceId }],
});

console.log("Created test account:", JSON.stringify(account));
console.log("Created reserved sandbox:", JSON.stringify(sandbox));
console.log("Created workspace:", JSON.stringify(workspace));
console.log("Created agent:", JSON.stringify(agent));

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
            "Run this reserved-sandbox test. Use exactly one bash call per numbered step.",
            "1. Create a virtualenv in your home with `python3 -m venv \"$HOME/.venv\"`, then",
            "   `\"$HOME/.venv/bin/pip\" install --quiet cowsay==6.1`, and print `cowsay-installed`.",
            "2. In a second bash call, confirm the package persists by running",
            "   `\"$HOME/.venv/bin/python\" -c \"import cowsay; print('cowsay', cowsay.__version__)\"`.",
            "3. Start a background job with bash background:true running:",
            "   `for i in $(seq 1 5); do echo \"tick $i\"; sleep 2; done; echo done`.",
            "   Report the resultId it returns.",
            "4. Call async_status with that resultId to check whether it is still running.",
            "5. Call async_status with action \"logs\" for that resultId and show the output so far.",
            "6. Summarize: confirm the venv package persisted and report the background job's status.",
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
