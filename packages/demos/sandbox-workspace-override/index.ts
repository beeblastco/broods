// The first `sandboxes` entry is the default; a workspace's own `sandbox` overrides it:
// an id uses that sandbox and its permissionMode, null forces read-only, omitted inherits.

import { BroodsClient, signUserToken } from "broods";
import { api } from "./broods/_generated/api";

// These agents need a signed user token; your backend signs one per signed-in user.
const client = new BroodsClient({
  userToken: () => signUserToken({ userId: "demo-user" }),
});

for await (const chunk of client.stream(api.agents.overrideAgent, {
  input: [
    "Exercise the three workspace bindings:",
    "1. In the `scratch` workspace, write a Python script that makes an outbound request and outputs the file 'output.txt', execute it and then read it back.",
    "2. In the `secure` workspace, write a Python script that makes an outbound request and outputs the file 'output.txt', try to execute it and then read it back.",
    "3. In the `reference` workspace, try to write c.txt, report the read-only error verbatim, then glob **/* there.",
    "4. Summarize which workspaces accepted writes and which rejected them. Dont use urlopen, if have problem, should timeout, or else it will hang indeffinetely",
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
