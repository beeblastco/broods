/**
 * Example async local tool flow.
 */

import { createAccount, createAgent, deleteAccount, streamSSE } from "./utils.ts";

const googleApiKey = process.env.ACCOUNT_GOOGLE_API_KEY!;

const account = await createAccount(`tool-async-${Date.now()}`);
const agent = await createAgent(account.accountSecret, "Async tool test assistant", {
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
    system: "When the user asks, call the test_async tool and then report the injected async result.",
  },
  tools: {
    test_async: {
      enabled: true,
      async: true,
    },
  },
});

console.log("Created test account:", JSON.stringify(account));
console.log("Created test agent:", JSON.stringify(agent));

try {
  for await (const chunk of streamSSE({
    agentId: agent.agent.agentId,
    eventId: `tool-async-${Date.now()}`,
    conversationKey: `tool-async-${Date.now()}`,
    events: [{
      role: "user",
      content: [{
        type: "text",
        text: "Call the test_async tool now and tell me the result after it finishes.",
      }],
    }],
  }, account.accountSecret)) {
    process.stdout.write(chunk + "\n\n");
  }
} finally {
  await deleteAccount(account.accountSecret);
  console.log("\n\nDeleted test account");
}
