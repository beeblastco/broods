/**
 * Example: one agent with a default sandbox plus an extra sandbox attached through
 * `sandboxes`. The model picks the machine per bash call, so the same command runs
 * with internet egress on one and with egress blocked on the other.
 */

import { BroodsClient } from "broods";
import { api } from "./broods/_generated/api";

const client = new BroodsClient();

for await (const chunk of client.stream(api.agents.multiSandboxAgent, {
  input: [
    "Use exactly one bash call per numbered step.",
    "1. On general-sandbox, run `curl -s --max-time 5 https://api.github.com/zen`.",
    '2. On offline-sandbox (bash `sandbox: "offline-sandbox"`), run the same command and report that it fails.',
    "3. On offline-sandbox, run `python3 -c 'print(sum(range(10)))'` to show local code still runs there.",
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
