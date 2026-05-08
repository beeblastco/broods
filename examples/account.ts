/**
 * Example Account Management (Create, Update, Delete)
 */

import { createAccount, createAgent, deleteAccount } from "./utils.ts";

// Define all the API keys and url required
const googleApiKey = process.env.ACCOUNT_GOOGLE_API_KEY!;

// Test username account
const username = `example-${Date.now()}`;

// Create account, then create an agent with runtime configuration.
const account = await createAccount(username);
const agent = await createAgent(account.accountSecret, "Example assistant", {
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
  // Workspace defaults to disabled, so memory/filesystem/tasks are off here.
});
console.log("Created test account:", JSON.stringify(account));
console.log("Created test agent:", JSON.stringify(agent));

// Delete account
await deleteAccount(account.accountSecret);
console.log("Deleted test account");
