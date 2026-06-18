/**
 * Example: E2B sandbox provider (stateless bash) via declarative filthy-panty resources.
 *
 * E2B runs each command in an ephemeral template sandbox and does NOT mount the S3
 * workspace, so workspace-backed tools (read/write/edit/glob/grep) are disabled. Reference
 * the sandbox WITHOUT a workspace for stateless `bash`. Use a template with Node + Python
 * installed; `apiKey` can be omitted when `E2B_API_KEY` is set on the harness runtime.
 */

import { FilthyPantyClient } from "filthy-panty";
import { api } from "./filthypanty/_generated/api";

// Create a client to connect to the Filthy Panty API.
const client = new FilthyPantyClient();

// Stream the response from the agent and print it to stdout.
for await (const chunk of client.stream(api.agents.e2bAgent, {
  input: [
    "Run this E2B smoke test using ONE bash call per numbered step.",
    "1. echo \"shell:$SANDBOX_SMOKE_VAR\" (expect sandbox-env-ok).",
    "2. In a single bash command, write main.py that prints the Python version, then run python3 main.py.",
    "3. In a single bash command, write main.js that prints the Node version, then run node main.js.",
    "4. Write a bash command that curls https://httpbin.org/get and prints the result.",
    "5. write and run the fibonacci sequence in bash up to the 10th number.",
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
