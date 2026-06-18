/**
 * Example: stateless bash-only sandbox through declarative filthypanty resources.
 */

import { FilthyPantyClient } from "filthy-panty";
import { api } from "./filthypanty/_generated/api";

// Create a client to connect to the Filthy Panty API.
const client = new FilthyPantyClient();

// Stream the response from the agent and print it to stdout.
for await (const chunk of client.stream(api.agents.myAgent, { 
  input: [
    "1. Run tools to write fib.py that prints the first 10 Fibonacci numbers, then run python3 fib.py.",
    "2. Run tools to write fib.js that does the same, then run node fib.js.",
    "3. Run `ls -1` on its own to show what files are present in the sandbox, and then run `cat` on each file to show their contents.",
  ].join("\n") 
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
