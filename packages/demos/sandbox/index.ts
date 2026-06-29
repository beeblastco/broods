/**
 * Example: a stateless, bash-only self-hosted `sandbox` (workdir) via declarative broods
 * resources. Exercises code execution, an injected config env var, internet egress, and
 * plain bash file management inside a fresh ephemeral container.
 */

import { BroodsClient } from "broods";
import { api } from "./broods/_generated/api";

// Create a client to connect to the Broods API.
const client = new BroodsClient();

// Stream the response from the agent and print it to stdout.
for await (const chunk of client.stream(api.agents.myAgent, {
  input: [
    "Use exactly one bash call per numbered step.",
    "1. Write fib.py that prints the first 10 Fibonacci numbers, then run python3 fib.py.",
    "2. Write fib.js that does the same, then run node fib.js.",
    "3. Echo the DEMO_GREETING environment variable to prove config env vars are injected.",
    "4. Confirm internet egress with `curl -s https://api.github.com/zen`.",
    "5. Run `ls -1` to show the files present, then `cat` each one to show its contents.",
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
