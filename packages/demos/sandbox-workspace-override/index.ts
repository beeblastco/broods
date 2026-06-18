/**
 * Example: per-workspace sandbox override via declarative filthy-panty resources.
 *
 * The agent-level `sandbox` is a DEFAULT. Each `workspaces[]` entry can set its own
 * `sandbox` to override it for that workspace. The cascade is:
 *
 *   ws.sandbox === <id>   -> override: use that sandbox (and ITS permissionMode)
 *   ws.sandbox === null   -> force read-only (read/glob via S3 only), even with a default
 *   ws.sandbox omitted    -> inherit the agent-level `sandbox`
 *
 * Here one agent drives three workspaces at once: one inherits the default sandbox, one is
 * pinned to a stricter deny-all network sandbox, and one is forced read-only.
 */

import { FilthyPantyClient } from "filthy-panty";
import { api } from "./filthypanty/_generated/api";

// Create a client to connect to the Filthy Panty API.
const client = new FilthyPantyClient();

// Stream the response from the agent and print it to stdout.
for await (const chunk of client.stream(api.agents.overrideAgent, {
  input: [
    "Exercise the three workspace bindings:",
    "1. In the `scratch` workspace, write a Python script that makes an outbound request and outputs the file 'output.txt', execute it and then read it back.",
    "2. In the `secure` workspace, write a Python script that makes an outbound request and outputs the file 'output.txt', try to execute it and then read it back.",
    "3. In the `reference` workspace, try to write c.txt — report the read-only error verbatim — then glob **/* there.",
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
        process.stdout.write(`\n\x1b[35m[Tool Result: ${JSON.stringify(chunk.output)}]\x1b[0m\n`);
        break;
      case "finish":
        process.stdout.write(`\n\x1b[37m[Finished: ${chunk.finishReason}]\x1b[0m\n`);
        break;
    }
}
