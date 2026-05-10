/**
 * Example tool approval flow.
 */

import {
  createAccount,
  createAgent,
  deleteAccount,
  pollStatus,
  postAsyncRequest,
  streamToolApprovalResponse,
} from "./utils.ts";

const googleApiKey = process.env.ACCOUNT_GOOGLE_API_KEY!;
const tavilyApiKey = process.env.ACCOUNT_TAVILY_API_KEY!;

const account = await createAccount(`approval-${Date.now()}`);
const agent = await createAgent(account.accountSecret, "Approval search assistant", {
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
    system: "Use Tavily search when current web information is needed.",
  },
  tools: {
    tavilySearch: {
      enabled: true,
      needsApproval: true,
      apiKey: tavilyApiKey,
      searchDepth: "advanced",
      includeAnswer: true,
      maxResults: 3,
    },
  },
});
const conversationKey = `approval-${Date.now()}`;

console.log("Created test account:", JSON.stringify(account));
console.log("Created test agent:", JSON.stringify(agent));

try {
  const { statusUrl } = await postAsyncRequest({
    agentId: agent.agent.agentId,
    eventId: `approval-request-${Date.now()}`,
    conversationKey,
    events: [{
      role: "user",
      content: [{
        type: "text",
        text: "Search the web for the latest OpenAI model release and summarize one result.",
      }],
    }],
  }, account.accountSecret);

  const status = await pollStatus(account.accountSecret, statusUrl);
  if (status.status !== "awaiting_approval" || !status.approvals?.[0]) {
    throw new Error(`Expected awaiting_approval, got ${JSON.stringify(status)}`);
  }

  const approval = status.approvals[0];
  console.log("Approving tool call:", JSON.stringify(approval, null, 2));

  for await (const chunk of streamToolApprovalResponse({
    accountSecret: account.accountSecret,
    agentId: agent.agent.agentId,
    conversationKey,
    approvalId: approval.approvalId,
    approved: true,
    reason: "Example script approved the search.",
  })) {
    process.stdout.write(chunk);
  }
} finally {
  await deleteAccount(account.accountSecret);
  console.log("\n\nDeleted test account");
}
