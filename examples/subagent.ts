/**
 * Example subagent dispatch over the sync SSE API.
 */

import { createAccount, createAgent, deleteAccount, streamSSE } from "./utils.ts";

const googleApiKey = process.env.ACCOUNT_GOOGLE_API_KEY!;
const account = await createAccount(`subagent-${Date.now()}`);
const parent = await createAgent(
  account.accountSecret,
  "Subagent parent assistant",
  {
    provider: {
      google: {
        apiKey: googleApiKey,
      },
    },
    model: {
      provider: "google",
      modelId: "gemma-4-31b-it",
    },
    agent: {
      system: "You are a helpful assistant.",
    },
    subagent: {
      enabled: true,
      allowed: [],
      context: "new",
    },
  },
);

console.log("Created test account:", JSON.stringify(account));
console.log("Created parent agent:", JSON.stringify(parent));

try {
  const timestamp = Date.now();
  const body = {
    agentId: parent.agent.agentId,
    eventId: `subagent-${timestamp}`,
    conversationKey: `subagent-${timestamp}`,
    events: [
      {
        role: "user",
        content: [{
          type: "text",
          text: [
            "Launch two subagents in parallel.",
            "One should outline the API integration risks for a new provider.",
            "The other should outline the operational risks for the same rollout.",
            "Compare their findings and provide a concise implementation checklist.",
          ].join(" "),
        }],
      },
    ],
  };

  for await (const chunk of streamSSE(body, account.accountSecret)) {
    process.stdout.write(chunk + "\n\n");
  }
} finally {
  await deleteAccount(account.accountSecret);
  console.log("\nDeleted test account");
}
