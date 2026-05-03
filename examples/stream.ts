/**
 * Example Stream SSE with tools
 */

import { createAccount, deleteAccount, streamSSE } from "./utils.ts";

// Define all the API keys and url required
const googleApiKey = process.env.ACCOUNT_GOOGLE_API_KEY!;
const tavilyApiKey = process.env.ACCOUNT_TAVILY_API_KEY!;

// Test username account
const username = `stream-${Date.now()}`;

// Create account with tools enabled
const account = await createAccount(username, {
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
  // Specific the system prompt
  systemPrompt: "You are a helpful assistant.",
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

try {
  // Stream SSE response
  const body = {
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
  for await (const chunk of streamSSE(body, account.accountSecret)) {
    process.stdout.write(chunk);
  }
} finally {
  // Delete account when finish
  await deleteAccount(account.accountSecret);
  console.log("\n\nDeleted test account");
}