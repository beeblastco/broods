/**
 * Example: a workspace-backed self-hosted `sandbox` (workdir) via declarative broods
 * resources. Demonstrates the shared S3 workspace mount: the file tools
 * (write/read/edit/glob/grep) operate on workspace-relative paths and the files persist
 * across calls, even though the compute container is ephemeral.
 */

import { BroodsClient } from "broods";
import { api } from "./broods/_generated/api";

// Create a client to connect to the Broods API.
const client = new BroodsClient();

// Stream the response from the agent and print it to stdout.
for await (const chunk of client.stream(api.agents.myAgent, {
  input: [
    "Run this workspace test. Use exactly one tool call per numbered step.",
    "1. Use the write tool to create src/greet.py containing a greet(name) function that",
    "   prints `Hello, <name>!`, plus a __main__ block that calls greet('workspace').",
    "2. Use the read tool to show src/greet.py with line numbers.",
    "3. Use the edit tool to change the greeting from 'Hello' to 'Hi'.",
    "4. Use glob to list `**/*.py`, then grep for `def greet` to confirm the match.",
    "5. Run `python3 src/greet.py` with bash and report the output.",
    "6. Summarize what the file tools did and confirm the file lives in the workspace.",
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
