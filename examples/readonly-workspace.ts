/**
 * Example: one shared workspace, two agents — writer (sandbox) + read-only reader (no sandbox).
 *
 * Both agents reference the SAME workspaceId, so they see the SAME files. The writer
 * references a sandbox and gets the full file tool set; the reader references the workspace
 * with NO sandbox, so it is read-only and serves read/glob straight from S3 (no mount, no
 * sandbox cold start).
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
const username = `ws-readonly-${Date.now()}`;

const account = await createAccount(username);

const sandbox = await createSandbox(account.secret, "writer-sandbox", {
  provider: "lambda",
  permissionMode: "bypass",
});

// One shared workspace (same workspaceId => same files for every agent).
const workspace = await createWorkspace(account.secret, "shared", {
  storage: { provider: "s3" },
}, "Shared workspace read by a sandbox-less agent");

const provider = { google: { apiKey: googleApiKey } };
const model = { provider: "google", modelId: "gemma-4-31b-it", temperature: 0 } as const;

// Writer: workspace + sandbox => full tool set (read/write/edit/glob/grep + bash).
const writer = await createAgent(account.secret, "Writer", {
  provider,
  model,
  sandbox: sandbox.sandboxId,
  workspaces: [{ name: "shared", workspaceId: workspace.workspaceId }],
});

// Reader: SAME workspace, NO sandbox => read-only (read/glob via S3 only, no compute).
const reader = await createAgent(account.secret, "Reader", {
  provider,
  model,
  workspaces: [{ name: "shared", workspaceId: workspace.workspaceId }],
});

console.log("Created test account:", JSON.stringify(account));
console.log("Created sandbox:", JSON.stringify(sandbox));
console.log("Created workspace:", JSON.stringify(workspace));
console.log("Created writer agent:", JSON.stringify(writer));
console.log("Created reader agent:", JSON.stringify(reader));

try {
  await run("writer seeds a file", {
    agentId: writer.agentId,
    eventId: `writer-${Date.now()}`,
    conversationKey: `writer-${Date.now()}`,
    events: [{
      role: "user",
      content: [{ type: "text", text: "Use the write tool to create report.md with the text 'shared via S3'." }],
    }],
  });

  await run("reader reads it back read-only (S3 direct)", {
    agentId: reader.agentId,
    eventId: `reader-${Date.now()}`,
    conversationKey: `reader-${Date.now()}`,
    events: [{
      role: "user",
      content: [{ type: "text", text: "Use glob to list **/*.md, then read report.md and return its contents." }],
    }],
  });
} finally {
  await deleteAccount(account.secret);
  console.log("\n\nDeleted test account");
}

async function run(label: string, body: Record<string, unknown>): Promise<void> {
  console.log(`\n[${label}]\n`);

  for await (const chunk of streamSSE(body, account.secret)) {
    process.stdout.write(`${chunk}\n\n`);
  }
}
