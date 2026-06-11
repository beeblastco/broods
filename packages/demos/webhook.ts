/**
 * Example webhook subscription flow.
 * Creates a temporary account and agent with webhook events configured,
 * sends a message to trigger the agent, and demonstrates how lifecycle
 * events are delivered to the mock-webhook-subscribe Lambda.
 *
 * The mock-webhook-subscribe Lambda logs all received webhook events
 * to CloudWatch. Check CloudWatch Logs to see the full event payloads.
 */

import { createAccount, createAgent, deleteAccount, streamSSE } from "filthy-panty";

const googleApiKey = process.env.ACCOUNT_GOOGLE_API_KEY!;
const tavilyApiKey = process.env.ACCOUNT_TAVILY_API_KEY!;
const mockWebhookUrl = process.env.MOCK_WEBHOOK_URL!;
const mockWebhookSecret = process.env.MOCK_WEBHOOK_SECRET!;

const account = await createAccount(`webhook-test-${Date.now()}`);

const agent = await createAgent(account.secret, "Webhook test assistant", {
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
    system: "You are a helpful assistant. Answer the user's question briefly.",
  },
    tools: {
    tavilySearch: {
      enabled: true,
      apiKey: tavilyApiKey,
      searchDepth: "advanced",
      includeAnswer: true,
      maxResults: 5,
      topic: "news",
    },
  },
  hooks: {
    webhook: {
      enabled: true,
      url: mockWebhookUrl,
      secret: mockWebhookSecret,
      events: [
        "agent.started",
        "tool.call.started",
        "tool.call.finished",
        "agent.finished",
        "agent.failed",
      ],
    },
  },
});

console.log("Created test account:", JSON.stringify(account));
console.log("Created test agent:", JSON.stringify(agent));
console.log("Webhook target:", mockWebhookUrl);
console.log("");
console.log("Check CloudWatch Logs for the mock-webhook-subscribe Lambda to see received events.");
console.log("");

try {
  const body = {
    agentId: agent.agentId,
    eventId: `test-${Date.now()}`,
    conversationKey: `test-${Date.now()}`,
    events: [
      {
        role: "user",
        content: [{
          type: "text",
          text: "What is the newest model release from OpenAI"
        }]
      },
    ],
  };
  for await (const chunk of streamSSE(body, account.secret)) {
    process.stdout.write(chunk + "\n\n");
  }
} finally {
  // Delete account when finish
  await deleteAccount(account.secret);
  console.log("\n\nDeleted test account");
}
