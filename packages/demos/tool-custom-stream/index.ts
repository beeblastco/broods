/**
 * Example: streaming an uploaded custom tool on the sync SSE path via declarative filthy-panty resources.
 *
 * The tool whose `execute` is an async generator streams preliminary tool-result
 * chunks live over SSE before the final result.
 */

import { FilthyPantyClient } from "filthy-panty";
import { api } from "./filthypanty/_generated/api";

const client = new FilthyPantyClient();

for await (const chunk of client.stream(api.agents.streamingToolAgent, {
  input: "Call the stream_progress tool with steps=5 and tell me the final result.",
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
