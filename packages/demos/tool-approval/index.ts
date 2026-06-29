/**
 * Example: tool approval flow via declarative broods resources.
 */

import type { ToolApprovalRequestOutput, ToolSet } from "ai";
import { BroodsClient } from "broods";
import { api } from "./broods/_generated/api";

type ToolApprovalRequestChunk = ToolApprovalRequestOutput<ToolSet>;

const client = new BroodsClient();

const conversationKey = `approval-${Date.now()}`;

// First pass: stream until approval request is received.
let approvalRequest: ToolApprovalRequestChunk | null = null;

for await (const chunk of client.stream(api.agents.approvalAgent, {
  input: "Search the web for the latest OpenAI model release and summarize one result.",
  conversationKey,
})) {
  switch (chunk.type) {
    case "reasoning-delta":
      process.stdout.write(`\x1b[90m${chunk.text}\x1b[0m`);
      break;
    case "reasoning-end":
      process.stdout.write(`\n\n`);
      break;
    case "text-delta":
      process.stdout.write(`\x1b[32m${chunk.text}\x1b[0m`);
      break;
    case "text-end":
      process.stdout.write(`\n\n`);
      break;
    case "tool-input-delta":
      process.stdout.write(`\x1b[36m${chunk.delta}\x1b[0m`);
      break;
    case "tool-call":
      process.stdout.write(`\n\x1b[36m[Tool Call: ${chunk.toolName}]\x1b[0m\n`);
      break;
    case "tool-result":
      process.stdout.write(`\n\x1b[35m[Tool Result: ${JSON.stringify(chunk.output)}]\x1b[0m\n`);
      break;
    case "finish":
      process.stdout.write(`\n\x1b[37m[Finished: ${chunk.finishReason}]\x1b[0m\n`);
      break;
  }

  const parsed = parseToolApprovalRequestChunk(chunk);
  if (parsed) {
    approvalRequest = parsed;
  }
}

if (!approvalRequest) {
  throw new Error("Expected sync stream to include a tool-approval-request chunk");
}

console.log("\n\nApproving tool call:", JSON.stringify(approvalRequest, null, 2));

// Second pass: respond with approval.
for await (const chunk of client.stream(api.agents.approvalAgent, {
  events: [{
    role: "tool",
    content: [{
      type: "tool-approval-response",
      approvalId: approvalRequest.approvalId,
      approved: true,
      reason: "Approved by example script",
    }],
  }],
  conversationKey,
})) {
  switch (chunk.type) {
    case "reasoning-delta":
      process.stdout.write(`\x1b[90m${chunk.text}\x1b[0m`);
      break;
    case "reasoning-end":
      process.stdout.write(`\n\n`);
      break;
    case "text-delta":
      process.stdout.write(`\x1b[32m${chunk.text}\x1b[0m`);
      break;
    case "text-end":
      process.stdout.write(`\n\n`);
      break;
    case "tool-input-delta":
      process.stdout.write(`\x1b[36m${chunk.delta}\x1b[0m`);
      break;
    case "tool-call":
      process.stdout.write(`\n\x1b[36m[Tool Call: ${chunk.toolName}]\x1b[0m\n`);
      break;
    case "tool-result":
      process.stdout.write(`\n\x1b[35m[Tool Result: ${JSON.stringify(chunk.output)}]\x1b[0m\n`);
      break;
    case "finish":
      process.stdout.write(`\n\x1b[37m[Finished: ${chunk.finishReason}]\x1b[0m\n`);
      break;
  }
}

function parseToolApprovalRequestChunk(chunk: unknown): ToolApprovalRequestChunk | null {
  try {
    const parsed = chunk as unknown;
    if (!isPlainObject(parsed) || parsed.type !== "tool-approval-request" || typeof parsed.approvalId !== "string") {
      return null;
    }

    const toolCall = parsed.toolCall;
    if (
      !isPlainObject(toolCall) ||
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
