/**
 * Example: per-workspace sandbox override.
 *
 * The agent-level `sandbox` is a DEFAULT. Each `workspaces[]` entry can set its own
 * `sandbox` to override it for that workspace. The cascade is:
 *
 *   ws.sandbox === <id>   -> override: use that sandbox (and ITS permissionMode)
 *   ws.sandbox === null   -> force read-only (read/glob via S3 only), even with a default
 *   ws.sandbox omitted    -> inherit the agent-level `sandbox`
 *
 * Here one agent drives three workspaces at once: one inherits the default sandbox, one is
 * pinned to a stricter no-internet sandbox, and one is forced read-only.
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
const username = `ws-override-${Date.now()}`;

const account = await createAccount(username);

// Default sandbox (internet on) — inherited by workspaces that don't override.
const defaultSandbox = await createSandbox(account.secret, "default-sandbox", {
  provider: "lambda",
  internet: true,
  permissionMode: "bypass",
  timeout: 60,
});

// Stricter sandbox (no internet) — pinned to the `secure` workspace only.
const secureSandbox = await createSandbox(account.secret, "secure-sandbox", {
  provider: "lambda",
  internet: false,
  permissionMode: "bypass",
  timeout: 60,
});

const scratch = await createWorkspace(account.secret, "scratch", {
  storage: { provider: "s3" },
}, "Inherits the agent default sandbox");

const secure = await createWorkspace(account.secret, "secure", {
  storage: { provider: "s3" },
}, "Pinned to the no-internet sandbox");

const reference = await createWorkspace(account.secret, "reference", {
  storage: { provider: "s3" },
}, "Forced read-only via sandbox: null");

const agent = await createAgent(account.secret, "Override assistant", {
  provider: {
    minimax: { apiKey: minimaxApiKey },
  },
  model: {
    provider: "minimax",
    modelId: "MiniMax-M3",
  },
  agent: {
    system: [
      "You have three workspaces with different sandbox bindings.",
      "scratch: full read/write via the default sandbox.",
      "secure: full read/write via a no-internet sandbox.",
      "reference: read-only (read/glob only) — write/edit are not available there.",
      "Always pass the matching `workspace` name to each file tool. Report errors verbatim.",
    ].join("\n"),
  },
  sandbox: defaultSandbox.sandboxId,
  workspaces: [
    // Omitted sandbox => inherits defaultSandbox.
    { name: "scratch", workspaceId: scratch.workspaceId },
    // Override => uses secureSandbox (and its no-internet permissionMode) for this workspace.
    { name: "secure", workspaceId: secure.workspaceId, sandbox: secureSandbox.sandboxId },
    // null => forced read-only, even though the agent has a default sandbox.
    { name: "reference", workspaceId: reference.workspaceId, sandbox: null },
  ],
});

console.log("Created test account:", JSON.stringify(account));
console.log("Created default sandbox:", JSON.stringify(defaultSandbox));
console.log("Created secure sandbox:", JSON.stringify(secureSandbox));
console.log("Created scratch workspace:", JSON.stringify(scratch));
console.log("Created secure workspace:", JSON.stringify(secure));
console.log("Created reference workspace:", JSON.stringify(reference));
console.log("Created test agent:", JSON.stringify(agent));

try {
  const body = {
    agentId: agent.agentId,
    eventId: `ws-override-${Date.now()}`,
    conversationKey: `ws-override-${Date.now()}`,
    events: [
      {
        role: "user",
        content: [{
          type: "text",
          text: [
            "Exercise the three workspace bindings:",
            "1. In the `scratch` workspace, write python script connect to internet and output the file 'output.txt', execute it and then read it back.",
            "2. In the `secure` workspace, write python script connect to internet and output the file 'output.txt', try execute it and then read it back.",
            "3. In the `reference` workspace, try to write c.txt — report the read-only error verbatim — then glob **/* there.",
            "4. Summarize which workspaces accepted writes and which rejected them. Dont use urlopen, if have problem, should timeout, or else it will hang indeffinetely",
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
