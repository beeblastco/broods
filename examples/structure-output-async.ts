/**
 * Example Async with structured output parsing
 */

import { createAccount, createAgent, deleteAccount, postAsyncRequest, pollStatus } from "./utils.ts";

// Define all the API keys and url required
const googleApiKey = process.env.ACCOUNT_GOOGLE_API_KEY!;

// Create account and an agent with tools enabled
const account = await createAccount(`async-${Date.now()}`);
const agent = await createAgent(account.accountSecret, "Structured assistant", {
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
  // Post async request
  const body = {
    agentId: agent.agent.agentId,
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
  const { statusUrl } = await postAsyncRequest(body, account.accountSecret);
  console.log("Status URL:", statusUrl);

  // Poll for result
  const result = await pollStatus(account.accountSecret, statusUrl);
  console.log(JSON.stringify(result, null, 2));
} finally {
  // Delete when finish
  await deleteAccount(account.accountSecret);
  console.log("\nDeleted test account");
}
