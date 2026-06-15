/**
 * Example: Vercel Sandbox provider with persistent lifecycle hooks via declarative filthy-panty resources.
 */

import { FilthyPantyClient } from "filthy-panty";
import { api } from "./filthypanty/_generated/api";

// Create a client to connect to the Filthy Panty API.
const client = new FilthyPantyClient({
  host: process.env.FILTHY_PANTY_HOST,
  apiKey: process.env.FILTHY_PANTY_API_KEY!,
});

// Stream the response from the agent and print it to stdout.
for await (const chunk of client.stream(api.agents.vercelAgent, {
  input: [
    "Run this Vercel Sandbox smoke test using separate bash calls.",
    "1. Print the contents of .fp-vercel-hook.txt and echo shell:$SANDBOX_SMOKE_VAR.",
    "2. Write hook-check.txt containing the hook file contents, then read it back.",
    "3. Start a background job with bash background:true that runs: sleep 2; echo vercel-bg-done.",
    "4. Poll async_status for the returned statusId until it is completed, then fetch logs.",
    "5. Summarize the hook side effects and the background job result.",
  ].join("\n"),
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
