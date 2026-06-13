/**
 * Example: E2B sandbox provider (stateless bash).
 *
 * E2B runs each command in an ephemeral template sandbox and does NOT mount the S3
 * workspace, so workspace-backed tools (read/write/edit/glob/grep) are disabled. Reference
 * the sandbox WITHOUT a workspace for stateless `bash`. Use a template with Node + Python
 * installed; `apiKey` can be omitted when `E2B_API_KEY` is set on the harness runtime.
 */

import {
  createAccount,
  createAgent,
  createSandbox,
  deleteAccount,
  streamSSE,
  requireEnv,
} from "filthy-panty";

const googleApiKey = requireEnv("ACCOUNT_GOOGLE_API_KEY");
const e2bApiKey = requireEnv("E2B_API_KEY");
const e2bTemplate = process.env.E2B_TEMPLATE ?? "runtime-template";
const username = `sandbox-e2b-${Date.now()}`;

const account = await createAccount(username);

const sandbox = await createSandbox(account.secret, "e2b-sandbox", {
  provider: "e2b",
  network: { mode: "allow-all" },
  permissionMode: "bypass",
  timeout: 120,
  outputLimitBytes: 65536,
  envVars: {
    SANDBOX_SMOKE_VAR: "sandbox-env-ok",
  },
  options: {
    apiKey: e2bApiKey,
    template: e2bTemplate,
    workspaceRoot: "/mnt/workspaces",
  },
});

const agent = await createAgent(account.secret, "E2B sandbox assistant", {
  provider: {
    google: { apiKey: googleApiKey },
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
  sandbox: sandbox.sandboxId,
  // No `workspaces`: E2B has no S3 mount, so the surface is stateless bash only.
});

console.log("Created test account:", JSON.stringify(account));
console.log("Created sandbox:", JSON.stringify(sandbox));
console.log("Created test agent:", JSON.stringify(agent));

try {
  const body = {
    agentId: agent.agentId,
    eventId: `sandbox-e2b-${Date.now()}`,
    conversationKey: `sandbox-e2b-${Date.now()}`,
    events: [
      {
        role: "user",
        content: [{
          type: "text",
          text: [
            "Run this E2B smoke test using ONE bash call per numbered step.",
            "1. echo \"shell:$SANDBOX_SMOKE_VAR\" (expect sandbox-env-ok).",
            "2. In a single bash command, write main.py that prints the Python version, then run python3 main.py.",
            "3. In a single bash command, write main.js that prints the Node version, then run node main.js.",
            "4. Summarize stdout and status for every step.",
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
