/**
 * Example async local tool flow.
 */

import { createAccount, createAgent, createTool, deleteAccount, streamSSE } from "filthy-panty";

const googleApiKey = process.env.ACCOUNT_GOOGLE_API_KEY!;

const account = await createAccount(`tool-async-${Date.now()}`);
const customTool = await createTool(account.secret, {
  name: "test_async",
  description: "Test async tool.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  bundle: `
export default {
  name: "test_async",
  async execute(ctx, input) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    return { type: "text", value: "test_async completed successfully" };
  },
};
`,
});
const agent = await createAgent(account.secret, "Async tool test assistant", {
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
    [customTool.toolId]: {
      enabled: true,
      async: true,
    },
  },
});

console.log("Created test account:", JSON.stringify(account));
console.log("Uploaded test tool:", JSON.stringify(customTool));
console.log("Created test agent:", JSON.stringify(agent));

try {
  for await (const chunk of streamSSE({
    agentId: agent.agentId,
    eventId: `tool-async-${Date.now()}`,
    conversationKey: `tool-async-${Date.now()}`,
    events: [{
      role: "user",
      content: [{
        type: "text",
        text: "Call the test_async tool now and tell me the result after it finishes.",
      }],
    }],
  }, account.secret)) {
    process.stdout.write(chunk + "\n\n");
  }
} finally {
  await deleteAccount(account.secret);
  console.log("\n\nDeleted test account");
}
