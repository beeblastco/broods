/**
 * Example: one shared workspace, three agents — a writer (sandbox) plus two read-only
 * readers that differ only in HOW they read.
 *
 * All three reference the SAME workspaceId, so they see the SAME files. The two readers
 * have no sandbox, so they are read-only (read/glob only). They demonstrate the two 2A
 * read paths:
 *   - reader-mount: workspace ref omits `sandbox` => reads through a service-managed
 *     read-only mount (the default) and sees the writer's committed file IMMEDIATELY.
 *   - reader-s3: workspace ref sets `sandbox: null` => opts out of the mount and reads
 *     straight from S3 (no Lambda/VPC, cheapest, but reads can lag the writer by the
 *     S3 export delay — see docs/workspace/sandbox/lambda.md).
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
}, "Shared workspace read by sandbox-less agents");

const provider = { google: { apiKey: googleApiKey } };
const model = { provider: "google", modelId: "gemma-4-31b-it", temperature: 0 } as const;

// Writer: workspace + sandbox => full tool set (read/write/edit/glob/grep + bash).
const writer = await createAgent(account.secret, "Writer", {
  provider,
  model,
  sandbox: sandbox.sandboxId,
  workspaces: [{ name: "shared", workspaceId: workspace.workspaceId }],
});

// Reader (default): SAME workspace, NO sandbox => read-only via the read-only MOUNT.
// Sees the writer's committed file immediately.
const readerMount = await createAgent(account.secret, "ReaderMount", {
  provider,
  model,
  workspaces: [{ name: "shared", workspaceId: workspace.workspaceId }],
});

// Reader (opt-out): SAME workspace, `sandbox: null` => read-only via S3 DIRECT.
// No compute; reads can lag the writer until the S3 export catches up.
const readerS3 = await createAgent(account.secret, "ReaderS3", {
  provider,
  model,
  workspaces: [{ name: "shared", workspaceId: workspace.workspaceId, sandbox: null }],
});

console.log("Created test account:", JSON.stringify(account));
console.log("Created sandbox:", JSON.stringify(sandbox));
console.log("Created workspace:", JSON.stringify(workspace));
console.log("Created writer agent:", JSON.stringify(writer));
console.log("Created reader-mount agent:", JSON.stringify(readerMount));
console.log("Created reader-s3 agent:", JSON.stringify(readerS3));

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

  // 2A run #1 — default read-only mount: should read the file back immediately.
  // The system will default to read only if provided on the workspace
  await run("reader-mount reads it back (read-only MOUNT, fresh)", {
    agentId: readerMount.agentId,
    eventId: `reader-mount-${Date.now()}`,
    conversationKey: `reader-mount-${Date.now()}`,
    events: [{
      role: "user",
      content: [{ type: "text", text: "Use glob to list **/*.md, then read report.md and return its contents. Try to update file report with new text" }],
    }],
  });

  // 2A run #2 — S3-direct opt-out (sandbox: null): same read, no mount/compute.
  await run("reader-s3 reads it back (S3 DIRECT opt-out)", {
    agentId: readerS3.agentId,
    eventId: `reader-s3-${Date.now()}`,
    conversationKey: `reader-s3-${Date.now()}`,
    events: [{
      role: "user",
      content: [{ type: "text", text: "Use glob to list **/*.md, then read report.md and return its contents. Try to update file report with new text" }],
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
