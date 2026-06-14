/**
 * Example Stream SSE with tools
 */

import { createAccount, createAgent, deleteAccount, FilthyPantyClient } from "filthy-panty";

// Define all the API keys and url required
const googleApiKey = process.env.ACCOUNT_GOOGLE_API_KEY!;
const tavilyApiKey = process.env.ACCOUNT_TAVILY_API_KEY!;

// Test username account
const username = `stream-${Date.now()}`;

// Create account and an agent with tools enabled
const account = await createAccount(username);
const agent = await createAgent(account.secret, "Search assistant", {
  // Add Google API key to the google provider.
  provider: {
    google: {
      apiKey: googleApiKey
    }
  },
  // Specific the model and provider will use.
  model: {
    provider: "google",
    modelId: "gemma-4-31b-it"
  },
  // Specify the agent behavior.
  agent: {
    system: "You are a helpful assistant.",
  },
  // Tools configuration with Tavily search enabled
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
});
console.log("Created test account:", JSON.stringify(account));
console.log("Created test agent:", JSON.stringify(agent));

try {
  // Stream the run through the core service using the SDK API key option.
  const client = new FilthyPantyClient({
    ...(process.env.AGENT_SERVICE_URL ? { baseUrl: process.env.AGENT_SERVICE_URL } : {}),
    apiKey: account.secret,
  });
  for await (const part of client.stream({
    agentId: agent.agentId,
    input: "What is the newest model release from OpenAI",
  })) {
    if (part.type === "text-delta") process.stdout.write(part.text);
  }
} finally {
  // Delete account when finish
  await deleteAccount(account.secret);
  console.log("\n\nDeleted test account");
}
