/**
 * Example: lambda sandbox + workspace, referenced from agent config by id.
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

const googleApiKey = requireEnv("ACCOUNT_GOOGLE_API_KEY");
const username = `sandbox-${Date.now()}`;

const account = await createAccount(username);

// 1) A standalone, account-scoped sandbox (the compute backend + permission mode).
const sandbox = await createSandbox(account.secret, "default-sandbox", {
  provider: "lambda",
  internet: true,
  permissionMode: "bypass",
  timeout: 60,
  envVars: {
    SANDBOX_SMOKE_VAR: "sandbox-env-ok",
  },
});

// 2) A standalone, account-scoped workspace (the persistent S3-backed filesystem).
const workspace = await createWorkspace(account.secret, "notes", {
  storage: { provider: "s3" },
  harness: { enabled: true },
});

// 3) The agent references both by id.
const agent = await createAgent(account.secret, "Sandbox assistant", {
  provider: {
    google: { apiKey: googleApiKey },
  },
  model: {
    provider: "google",
    modelId: "gemma-4-31b-it",
    temperature: 0,
  },
  agent: {
    system: "You are testing the workspace sandbox.",
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
            "Run this exact native mounted sandbox smoke test, covering env vars and outbound internet.",
            "",
            "Env var check (the sandbox configured SANDBOX_SMOKE_VAR=sandbox-env-ok):",
            "1. Run the bash command: echo \"shell:$SANDBOX_SMOKE_VAR\".",
            "2. Use the write tool to create env.py that prints `python:` followed by os.environ['SANDBOX_SMOKE_VAR'], then run python3 env.py with bash.",
            "3. Use the write tool to create env.js that prints `node:` followed by process.env.SANDBOX_SMOKE_VAR, then run node env.js with bash.",
            "4. Confirm all three print sandbox-env-ok.",
            "",
            "Outbound-internet check:",
            "5. Write weather.py with Python that uses urllib.request to GET https://api.open-meteo.com/v1/forecast?latitude=37.7749&longitude=-122.4194&current_weather=true&temperature_unit=fahrenheit and prints the JSON response.",
            "6. Run python3 weather.py with bash.",
            "7. Write weather.js with JavaScript that calls fetch on the same URL and prints await response.text().",
            "8. Run node weather.js with bash.",
            "9. Return the stdout and status from every run.",
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
