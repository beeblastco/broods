/**
 * Example: Cloudflare Containers sandbox provider (persistent bash) via declarative
 * broods resources. No workspace mount, so only `bash` is exposed. The container
 * keeps its files while warm and loses them when it sleeps.
 */

import { BroodsClient } from "broods";
import { api } from "./broods/_generated/api";

const client = new BroodsClient();

for await (const chunk of client.stream(api.agents.cloudflareAgent, {
  input: [
    "Run this Cloudflare smoke test using ONE bash call per numbered step.",
    '1. echo "shell:$SANDBOX_SMOKE_VAR" (expect sandbox-env-ok).',
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
