/**
 * Example: workspace sandbox execution on the Beeblast k3s cluster via the
 * `kubernetes` provider (agent-sandbox runtime pods).
 *
 * Mirrors examples/sandbox.ts but selects provider: "kubernetes". Requires the
 * harness to be deployed with the kubernetes sandbox provider and reachable at
 * ACCOUNT_SERVICE_URL / AGENT_SERVICE_URL, with the cluster kubeconfig provided
 * to the harness runtime (KUBERNETES_SANDBOX_KUBECONFIG) — see
 * functions/harness-processing/sandbox/kubernetes-executor.ts.
 *
 * Run: bun run examples/sandbox-kubernetes.ts
 */

import { createAccount, createAgent, deleteAccount, streamSSE, requireEnv } from "./utils.ts";

const googleApiKey = requireEnv("ACCOUNT_GOOGLE_API_KEY");
const username = `sandbox-k8s-${Date.now()}`;

const account = await createAccount(username);
const agent = await createAgent(account.secret, "Kubernetes sandbox assistant", {
  provider: {
    google: {
      apiKey: googleApiKey,
    },
  },
  model: {
    provider: "google",
    modelId: "gemma-4-31b-it",
    temperature: 0,
  },
  agent: {
    system: [
      "You are testing the kubernetes workspace sandbox.",
      "The sandbox is a real VM-like pod: bash, node, and python3 are on PATH.",
      "Use the bash tool to write source files first, then execute file-based scripts.",
      "Do not use inline execution such as node -e or python -c.",
      "After running files, summarize stdout, generated files, and status for each run.",
    ].join("\n"),
  },
  workspace: {
    enabled: true,
    needsApproval: false,
    storage: {
      provider: "s3",
    },
    sandbox: {
      provider: "kubernetes",
      timeout: 60,
      outputLimitBytes: 65536,
      envVars: {
        SANDBOX_SMOKE_VAR: "sandbox-env-ok",
      },
      options: {
        // Optional overrides; defaults live in the executor + harness env:
        // namespace: "agent-sandboxes",
        // image: "ghcr.io/beeblastco/agent-sandbox-runtime:latest",
        // serviceAccountName: "agent-sandbox-workspace",
        // imagePullSecrets: ["ghcr-pull-secret"],
        // mountAwsS3Buckets: true,
        // workspaceBucketName: "<filthy-panty memory bucket>",
        workspaceRoot: "/mnt/workspaces",
      },
    },
  },
});

console.log("Created test account:", JSON.stringify(account));
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
            "Run this kubernetes sandbox smoke test:",
            "1. Run the shell command: echo \"shell:$SANDBOX_SMOKE_VAR\" (expect sandbox-env-ok).",
            "2. Write /main.py that prints 'python ok' plus the Python version, then run python3 /main.py.",
            "3. Write /main.js that prints 'node ok' plus process.version, then run node /main.js.",
            "4. Run: curl -s -o /dev/null -w '%{http_code}' https://example.com  (outbound internet check).",
            "5. Return the stdout and status objects from every run.",
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
