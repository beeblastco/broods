/**
 * Example: Daytona sandbox + S3-backed workspace via declarative broods resources.
 */

import { BroodsClient, signUserToken } from "broods";
import { api } from "./broods/_generated/api";

// The demo's agents require a signed user token beside the runtime key.
// Your backend signs one per signed-in user; here one demo user stands in.
const client = new BroodsClient({
  userToken: () => signUserToken({ userId: "demo-user" }),
});

for await (const chunk of client.stream(api.agents.sandboxAssistant, {
  input:
    "Interacte with the sandbox for me, write file, access internet, etc. Play with it.",
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
