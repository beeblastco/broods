// No workspace mount, so only `bash`, and only just-bash built-ins: no python, no node.
// A persistent sandbox keeps its files in storage between calls.

import { BroodsClient, signUserToken } from "broods";
import { api } from "./broods/_generated/api";

// These agents need a signed user token; your backend signs one per signed-in user.
const client = new BroodsClient({
  userToken: () => signUserToken({ userId: "demo-user" }),
});

for await (const chunk of client.stream(api.agents.workerAgent, {
  input: [
    "Run this V8 Worker smoke test using ONE bash call per numbered step.",
    '1. echo "shell:$SANDBOX_SMOKE_VAR" (expect sandbox-env-ok).',
    "2. Write a JSON file with three users and ages, then print the oldest user's name with jq.",
    "3. curl https://httpbin.org/get and print the origin field with jq.",
    "4. Print the file from step 2 again: it is still there, the sandbox is persistent.",
    "5. Compute the first 10 Fibonacci numbers with a bash loop.",
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
