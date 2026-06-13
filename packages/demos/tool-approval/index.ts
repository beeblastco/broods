/**
 * Example tool approval flow.
 */

import type { ToolApprovalRequestOutput, ToolSet } from "ai";

import {
  createAccount,
  createAgent,
  deleteAccount,
  streamSSE,
} from "filthy-panty";

type ToolApprovalRequestChunk = ToolApprovalRequestOutput<ToolSet>;

const googleApiKey = process.env.ACCOUNT_GOOGLE_API_KEY!;
const tavilyApiKey = process.env.ACCOUNT_TAVILY_API_KEY!;

const account = await createAccount(`approval-${Date.now()}`);
const agent = await createAgent(account.secret, "Approval search assistant", {
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
  let approvalRequest: ToolApprovalRequestChunk | null = null;

  for await (const chunk of streamSSE({
    agentId: agent.agentId,
    eventId: `approval-request-${Date.now()}`,
    conversationKey: conversationKey,
    events: [{
      role: "user",
      content: [{
        type: "text",
        text: "Search the web for the latest OpenAI model release and summarize one result.",
      }],
    }],
  }, account.secret)) {
    process.stdout.write(chunk + "\n\n");
    const parsedChunk = parseToolApprovalRequestChunk(chunk);
    if (parsedChunk) {
      approvalRequest = parsedChunk;
    }
  }

  if (!approvalRequest) {
    throw new Error("Expected sync stream to include a tool-approval-request chunk");
  }

  console.log("\n\nApproving tool call:", JSON.stringify(approvalRequest, null, 2));

  for await (const chunk of streamSSE({
    agentId: agent.agentId,
    eventId: `approval-${Date.now()}`,
    conversationKey: conversationKey,
    events: [{
      role: "tool",
      content: [{
        type: "tool-approval-response",
        approvalId: approvalRequest.approvalId,
        approved: true,
        reason: "Approved by example script",
      }],
    }],
  }, account.secret)) {
    process.stdout.write(chunk + "\n\n");
  }
} finally {
  await deleteAccount(account.secret);
  console.log("\n\nDeleted test account");
}

function parseToolApprovalRequestChunk(chunk: string): ToolApprovalRequestChunk | null {
  try {
    const parsed = JSON.parse(chunk) as unknown;
    if (!isRecord(parsed) || parsed.type !== "tool-approval-request" || typeof parsed.approvalId !== "string") {
      return null;
    }

    const toolCall = parsed.toolCall;
    if (
      !isRecord(toolCall) ||
      toolCall.type !== "tool-call" ||
      typeof toolCall.toolCallId !== "string" ||
      typeof toolCall.toolName !== "string"
    ) {
      return null;
    }

    return parsed as ToolApprovalRequestChunk;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
