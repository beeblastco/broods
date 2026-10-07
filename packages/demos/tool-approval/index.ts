/**
 * Example: tool approval flow via declarative broods resources.
 */

import { BroodsClient } from "broods";
import { api } from "./broods/_generated/api";

const client = new BroodsClient();

const conversationKey = `approval-${Date.now()}`;

// First pass: stream until approval request is received.
let approvalRequest: { approvalId: string; toolName: string } | null = null;

for await (const chunk of client.stream(api.agents.approvalAgent, {
  input:
    "Search the web for the latest OpenAI model release and summarize one result.",
  conversationKey: conversationKey,
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
      process.stdout.write(
        `\n\x1b[35m[Tool Result: ${JSON.stringify(chunk.output)}]\x1b[0m\n`,
      );
      break;
    case "finish":
      process.stdout.write(
        `\n\x1b[37m[Finished: ${chunk.finishReason}]\x1b[0m\n`,
      );
      break;
    case "tool-approval-request":
      approvalRequest = {
        approvalId: chunk.approvalId,
        toolName: chunk.toolCall.toolName,
      };
      break;
  }
}

if (!approvalRequest) {
  throw new Error(
    "Expected sync stream to include a tool-approval-request chunk",
  );
}

console.log(
  "\n\nApproving tool call:",
  JSON.stringify(approvalRequest, null, 2),
);

// Second pass: respond with approval.
for await (const chunk of client.stream(api.agents.approvalAgent, {
  events: [
    {
      role: "tool",
      content: [
        {
          type: "tool-approval-response",
          approvalId: approvalRequest.approvalId,
          approved: true,
          reason: "Approved by example script",
        },
      ],
    },
  ],
  conversationKey: conversationKey,
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
      process.stdout.write(
        `\n\x1b[35m[Tool Result: ${JSON.stringify(chunk.output)}]\x1b[0m\n`,
      );
      break;
    case "finish":
      process.stdout.write(
        `\n\x1b[37m[Finished: ${chunk.finishReason}]\x1b[0m\n`,
      );
      break;
  }
}
