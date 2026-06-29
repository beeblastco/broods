/**
 * Example: a reserved (persistent) self-hosted coding sandbox via declarative broods resources.
 *
 * Demonstrates the `persistent: true` lifecycle on the `sandbox` (workdir) provider — a
 * long-lived sandbox per workspace (installed packages + code survive idle), native
 * pause/standby idle scale-down, and a detached background job observed with the
 * auto-registered `async_status` tool.
 */

import { BroodsClient } from "broods";
import { api } from "./broods/_generated/api";

// Create a client to connect to the Broods API.
const client = new BroodsClient();

// Stream the response from the agent and print it to stdout.
for await (const chunk of client.stream(api.agents.reservedAgent, {
  input: [
    "Run this reserved-sandbox test. Use exactly one bash call per numbered step.",
    "1. Create a virtualenv in your home with `python3 -m venv \"$HOME/.venv\"`, then",
    "   `\"$HOME/.venv/bin/pip\" install --quiet cowsay==6.1`, and print `cowsay-installed`.",
    "2. In a second bash call, confirm the package persists by running",
    "   `\"$HOME/.venv/bin/python\" -c \"import cowsay; print('cowsay', cowsay.__version__)\"`.",
    "3. Start a background job with bash background:true running:",
    "   `for i in $(seq 1 5); do echo \"tick $i\"; sleep 2; done; echo done`.",
    "   Report the resultId it returns.",
    "4. Call async_status with that resultId to check whether it is still running.",
    "5. Call async_status with action \"logs\" for that resultId and show the output so far.",
    "6. Summarize: confirm the venv package persisted and report the background job's status.",
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
