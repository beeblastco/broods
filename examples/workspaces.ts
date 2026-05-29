/**
 * Example multi-workspace streaming invocation.
 */

import { createAccount, createAgent, deleteAccount, requireEnv, streamSSE } from "./utils.ts";

const googleApiKey = requireEnv("ACCOUNT_GOOGLE_API_KEY");
const username = `workspaces-${Date.now()}`;

const account = await createAccount(username);
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
      "Use the default personal workspace for private per-conversation files.",
      "Use the team workspace when the user asks for shared team files.",
      "Report any bash tool error exactly.",
    ].join("\n"),
  },
  workspace: {
    enabled: true,
    needsApproval: false,
    defaultWorkspace: "personal",
    workspaces: {
      personal: {
        description: "Private per-conversation files and MEMORY.md",
      },
      team: {
        namespace: "shared-demo-team",
        description: "Shared team files and MEMORY.md across conversations",
      },
    },
    storage: {
      provider: "s3",
    },
    sandbox: {
      provider: "lambda",
      timeout: 30,
      outputLimitBytes: 65536,
      options: {
        networkAccess: "disabled",
      },
    },
  },
});

console.log("Created test account:", JSON.stringify(account));
console.log("Created test agent:", JSON.stringify(agent));

try {
  const firstConversation = `workspace-personal-${Date.now()}`;
  const secondConversation = `workspace-team-${Date.now()}`;

  await runAndCheck("create personal and team files", {
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

  await runAndCheck("verify isolation and shared team state", {
    agentId: agent.agentId,
    eventId: `workspaces-verify-${Date.now()}`,
    conversationKey: secondConversation,
    events: [{
      role: "user",
      content: [{
        type: "text",
        text: [
          "Run these exact workspace checks from this new conversation.",
          "1. In the default personal workspace, test whether personal.txt exists.",
          "2. In the team workspace, read team.txt.",
          "3. Report that personal.txt is absent in this conversation and team.txt contains team-shared.",
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
    assertStreamEventOk(label, chunk);
  }
}

function assertStreamEventOk(label: string, chunk: string): void {
  let event: unknown;
  try {
    event = JSON.parse(chunk);
  } catch {
    return;
  }

  if (!event || typeof event !== "object") {
    return;
  }

  const record = event as Record<string, unknown>;
  if (record.type === "error") {
    throw new Error(`Stream reported an agent error during ${label}: ${chunk}`);
  }

  if (record.type !== "tool-result") {
    return;
  }

  const output = record.output;
  if (!output || typeof output !== "object") {
    return;
  }

  const outputRecord = output as Record<string, unknown>;
  if (outputRecord.type === "error-text") {
    throw new Error(`Stream reported a workspace tool error during ${label}: ${String(outputRecord.value ?? "")}`);
  }
}
