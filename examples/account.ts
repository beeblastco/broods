/**
 * Example Account Management (Create, Update, Delete)
 */

import { createAccount, updateAccount, deleteAccount } from "./utils.ts";

// Define all the API keys and url required
const googleApiKey = process.env.ACCOUNT_GOOGLE_API_KEY!;

// Test username account
const username = `example-${Date.now()}`;

// Create account
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
  // Specify the agent behavior.
  agent: {
    system: "You are a helpful assistant.",
  },
  // Workspace defaults to disabled, so memory/filesystem/tasks are off here.
});
console.log("Created test account:", JSON.stringify(account));

// Update account
await updateAccount(account.accountSecret, {
  agent: {
    system: "You are a concise assistant. Keep answers brief.",
  },
});
console.log("Updated successfully");

// Delete account
await deleteAccount(account.accountSecret);
console.log("Deleted test account");
