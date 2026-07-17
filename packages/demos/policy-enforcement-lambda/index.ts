/**
 * Example: OPA-backed agent policy rollout modes on the AWS Lambda MicroVM
 * sandbox with Bedrock MiniMax.
 */

import { BroodsClient } from "broods";
import { api } from "./broods/_generated/api";

const client = new BroodsClient();

const input = [
  "Run the policy smoke test now.",
  "Call bash exactly once with this command:",
  "printf 'POLICY_SMOKE_OK\\n'",
  "Then say whether the command ran or policy blocked it.",
].join("\n");

async function runDemo(
  label: string,
  agent: (typeof api.agents)[keyof typeof api.agents],
  conversationKeyPrefix: string,
) {
  console.log(`\n=== ${label} ===\n`);
  for await (const chunk of client.stream(agent, {
    input,
    conversationKey: `${conversationKeyPrefix}-${Date.now()}`,
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
        process.stdout.write(
          `\n\x1b[36m[Tool Call: ${chunk.toolName}]\x1b[0m\n`,
        );
        break;
      case "tool-result":
        process.stdout.write(
          `\n\x1b[35m[Tool Result: ${JSON.stringify(chunk.output)}]\x1b[0m\n`,
        );
        break;
      case "tool-output-denied":
        process.stdout.write(
          `\n\x1b[33m[Tool Output Denied: ${chunk.toolName}]\x1b[0m\n`,
        );
        break;
      case "tool-error":
        process.stdout.write(
          `\n\x1b[31m[Tool Error: ${chunk.toolName}] ${JSON.stringify(chunk.error)}\x1b[0m\n`,
        );
        break;
      case "error":
        process.stdout.write(
          `\n\x1b[31m[Error: ${JSON.stringify(chunk.error)}]\x1b[0m\n`,
        );
        break;
      case "finish":
        process.stdout.write(
          `\n\x1b[37m[Finished: ${chunk.finishReason}]\x1b[0m\n`,
        );
        break;
    }
  }
}

await runDemo("AUDIT MODE", api.agents.auditPolicyAgent, "policy-audit");
await runDemo("ENFORCE MODE", api.agents.enforcePolicyAgent, "policy-enforce");
