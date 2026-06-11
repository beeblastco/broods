/**
 * Example: one agent with two named S3-backed workspaces.
 */

import {
  createAccount,
  createAgent,
  createSandbox,
  createWorkspace,
  deleteAccount,
  requireEnv,
  streamSSE,
} from "filthy-panty";

const googleApiKey = requireEnv("ACCOUNT_GOOGLE_API_KEY");
const username = `workspaces-${Date.now()}`;

const account = await createAccount(username);

const sandbox = await createSandbox(account.secret, "lambda-sandbox", {
  provider: "lambda",
  permissionMode: "bypass",
  timeout: 30,
  outputLimitBytes: 65536,
  network: { mode: "deny-all" },
});

const personal = await createWorkspace(account.secret, "personal", {
  storage: { provider: "s3" },
}, "Agent notes workspace");

const team = await createWorkspace(account.secret, "team", {
  storage: { provider: "s3" },
}, "Shared team workspace");

const agent = await createAgent(account.secret, "Multi-workspace assistant", {
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
      "You are testing named workspaces.",
      "Use the bash tool for every filesystem check.",
      "Use the default personal workspace for notes.",
      "Use the team workspace when the user asks for shared team files.",
      "Report any bash tool error exactly.",
    ].join("\n"),
  },
  sandbox: sandbox.sandboxId,
  workspaces: [
    { name: "personal", workspaceId: personal.workspaceId },
    { name: "team", workspaceId: team.workspaceId },
  ],
});

console.log("Created test account:", JSON.stringify(account));
console.log("Created sandbox:", JSON.stringify(sandbox));
console.log("Created personal workspace:", JSON.stringify(personal));
console.log("Created team workspace:", JSON.stringify(team));
console.log("Created test agent:", JSON.stringify(agent));

try {
  const firstConversation = `workspace-personal-${Date.now()}`;
  const secondConversation = `workspace-team-${Date.now()}`;

  await runAndCheck("create files in two named workspaces", {
    agentId: agent.agentId,
    eventId: `workspaces-create-${Date.now()}`,
    conversationKey: firstConversation,
    events: [{
      role: "user",
      content: [{
        type: "text",
        text: [
          "Run these exact workspace checks.",
          "1. In the default personal workspace, write personal.txt containing only personal-alpha.",
          "2. In the team workspace, write team.txt containing only team-shared.",
          "3. Read both files back with bash and summarize the exact stdout.",
        ].join("\n"),
      }],
    }],
  });

  await runAndCheck("verify both workspaces persist by workspaceId", {
    agentId: agent.agentId,
    eventId: `workspaces-verify-${Date.now()}`,
    conversationKey: secondConversation,
    events: [{
      role: "user",
      content: [{
        type: "text",
        text: [
          "Run these exact workspace checks from this new conversation.",
          "1. In the default personal workspace, read personal.txt.",
          "2. In the team workspace, read team.txt.",
          "3. Report that personal.txt contains personal-alpha and team.txt contains team-shared.",
        ].join("\n"),
      }],
    }],
  });
} finally {
  await deleteAccount(account.secret);
  console.log("\nDeleted test account");
}

async function runAndCheck(label: string, body: Record<string, unknown>): Promise<void> {
  console.log(`\n[${label}]\n`);

  for await (const chunk of streamSSE(body, account.secret)) {
    process.stdout.write(`${chunk}\n\n`);
  }
}
