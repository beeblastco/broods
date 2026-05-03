/**
 * Example Async endpoint with polling
 */

import { createAccount, deleteAccount, postAsyncRequest, pollStatus } from "./utils.ts";

// Define all the API keys and url required
const googleApiKey = process.env.ACCOUNT_GOOGLE_API_KEY!;
const tavilyApiKey = process.env.ACCOUNT_TAVILY_API_KEY!;

// Create account with tools enabled
const account = await createAccount(`async-${Date.now()}`, {
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
  // Post async request
  const body = {
    eventId: `async-${Date.now()}`,
    conversationKey: `async-${Date.now()}`,
    events: [
      { 
        role: "user", 
        content: [{ 
          type: "text", 
          text: "Search the web for the latest weather in Hanoi." 
        }] 
      },
    ],
  }
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