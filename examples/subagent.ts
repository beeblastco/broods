/**
 * Example subagent dispatch over the sync SSE API.
 */

import { createAccount, createAgent, deleteAccount, streamSSE } from "./utils.ts";

const googleApiKey = process.env.ACCOUNT_GOOGLE_API_KEY!;
const tavilyApiKey = process.env.ACCOUNT_TAVILY_API_KEY!;

const account = await createAccount(`subagent-${Date.now()}`);
const parent = await createAgent(
  account.accountSecret,
  "Subagent parent assistant",
  {
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
      system: "You are a helpful assistant. Please do not use the search tool unless you are asked to.",
    },
    tools: {
        tavilySearch: {
            enabled: true,
            apiKey: tavilyApiKey,
            searchDepth: "advanced",
            includeAnswer: true,
            maxResults: 3,
        },
    },
    subagent: {
      enabled: true,
      allowed: [],
      context: "new",
    },
  },
);

console.log("Created test account:", JSON.stringify(account));
console.log("Created parent agent:", JSON.stringify(parent));

try {
  const timestamp = Date.now();
  const body = {
    agentId: parent.agent.agentId,
    eventId: `subagent-${timestamp}`,
    conversationKey: `subagent-${timestamp}`,
    events: [
      {
        role: "user",
        content: [{
          type: "text",
          text: [
            "Launch two subagents in parallel to ",
            "research for me the newest model release from OpenAI",
            "and for Anthropic model",
            "Compare thier two model in coding capability, which one is better in coding",
          ].join(" "),
        }],
      },
    ],
  };

  for await (const chunk of streamSSE(body, account.accountSecret)) {
    process.stdout.write(chunk + "\n\n");
  }
} finally {
  await deleteAccount(account.accountSecret);
  console.log("\nDeleted test account");
}
