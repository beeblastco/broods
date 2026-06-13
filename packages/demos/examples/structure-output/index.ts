/**
 * Example Stream SSE with structured output parsing
 */

import { createAccount, createAgent, deleteAccount, streamSSE } from "filthy-panty";

// Define all the API keys and url required
const googleApiKey = process.env.ACCOUNT_GOOGLE_API_KEY!;

// Test username account
const username = `stream-${Date.now()}`;

// Create account and an agent with structured output
const account = await createAccount(username);
const agent = await createAgent(account.secret, "Structured assistant", {
  // Add Google API key to the google provider.
  provider: {
    google: {
      apiKey: googleApiKey
    }
  },
  // Specify the model and provider will use.
  model: {
    provider: "google",
    modelId: "gemma-4-31b-it",
    output: {
      type: "object",
      name: "AgentAnswer",
      description: "A concise answer with optional follow-up actions.",
      schema: {
        type: "object",
        properties: {
          answer: { type: "string" },
          actions: {
            type: "array",
            items: { type: "string" }
          }
        },
        required: ["answer"],
        additionalProperties: false
      }
    }
  },
  // Specify the agent behavior.
  agent: {
    system: "You are a helpful assistant that returns structured output.",
  },
});
console.log("Created test account:", JSON.stringify(account));
console.log("Created test agent:", JSON.stringify(agent));

try {
  // Stream SSE response
  const body = {
    agentId: agent.agentId,
    eventId: `test-${Date.now()}`,
    conversationKey: `test-${Date.now()}`,
    events: [
      {
        role: "user",
        content: [{
          type: "text",
          text: "What is the newest model release from OpenAI? Provide a concise answer and suggest follow-up actions."
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
