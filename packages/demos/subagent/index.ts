/**
 * Example: subagent dispatch via declarative broods resources.
 */

import { BroodsClient } from "broods";
import { api } from "./broods/_generated/api";

// Create a client to connect to the Broods API.
const client = new BroodsClient();

// Stream the response from the parent agent and print it to stdout.
for await (const chunk of client.stream(api.agents.parent, {
  input: [
    "Launch two subagents in parallel to",
    "research the newest model release from OpenAI",
    "and the newest model release from Anthropic.",
    "Compare their coding capabilities and say which is better for coding.",
  ].join(" "),
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
