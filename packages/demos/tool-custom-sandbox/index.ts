/**
 * Example: an uploaded custom tool that needs the Node runtime.
 *
 * The bundle imports `node:` builtins, so it runs in the tool-runner Lambda
 * rather than the V8 isolate. The tool result also reports whether the runner's
 * AWS credentials were visible to it, which is the containment check.
 */

import { BroodsClient } from "broods";
import { api } from "./broods/_generated/api";

const client = new BroodsClient();

for await (const chunk of client.stream(api.agents.sandboxToolAgent, {
  input:
    'Call the system_report tool with payload "broods sandbox tier" and report every field it returns.',
})) {
  switch (chunk.type) {
    case "text-delta":
      process.stdout.write(`\x1b[32m${chunk.text}\x1b[0m`);
      break;
    case "text-end":
      process.stdout.write(`\n\n`);
      break;
    case "tool-call":
      process.stdout.write(`\n\x1b[36m[Tool Call: ${chunk.toolName}]\x1b[0m\n`);
      break;
    case "tool-result":
      process.stdout.write(
        `\n\x1b[35m[Tool Result: ${JSON.stringify(chunk.output, null, 2)}]\x1b[0m\n`,
      );
      break;
    case "error":
      process.stdout.write(`\n\x1b[31m[Error: ${chunk.errorText}]\x1b[0m\n`);
      break;
  }
}
