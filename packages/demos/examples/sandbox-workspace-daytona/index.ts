/**
 * Example: Daytona sandbox + S3-backed workspace, referenced by id.
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
const daytonaApiKey = requireEnv("DAYTONA_API_KEY");
const daytonaOrganizationId = process.env.DAYTONA_ORGANIZATION_ID!;
const username = `sandbox-${Date.now()}`;

const account = await createAccount(username);

const sandbox = await createSandbox(account.secret, "daytona-sandbox", {
  provider: "daytona",
  network: { mode: "allow-all" },
  permissionMode: "bypass",
  timeout: 120,
  outputLimitBytes: 65536,
  options: {
    apiKey: daytonaApiKey,
    organizationId: daytonaOrganizationId,
    apiUrl: "https://app.daytona.io/api",
    target: "eu",
    snapshot: "fuse-s3",
    workspaceRoot: "/mnt/workspaces",
    mountAwsS3Buckets: true,
  },
});

const workspace = await createWorkspace(account.secret, "notes", {
  storage: { provider: "s3" },
  harness: { enabled: true },
});

const agent = await createAgent(account.secret, "Sandbox assistant", {
  provider: {
    minimax: {
      apiKey: minimaxApiKey,
    },
  },
  model: {
    provider: "minimax",
    modelId: "MiniMax-M3",
  },
  agent: {
    system: [
      "You are testing the workspace sandbox.",
      "The sandbox uses a native mounted workspace filesystem.",
      "Use normal relative file APIs from the workspace root.",
      "After running files, summarize stdout, generated files, and status for each run.",
    ].join("\n"),
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
          text: "Call outside API and check for me the weather in San Francisco, CA.",
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
