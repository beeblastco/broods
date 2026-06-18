/**
 * Example: one agent with two named S3-backed workspaces via declarative filthy-panty resources.
 */

import { FilthyPantyClient } from "filthy-panty";
import { api } from "./filthypanty/_generated/api";

// Create a client to connect to the Filthy Panty API.
const client = new FilthyPantyClient();

async function runAgent(label: string, input: string): Promise<void> {
  console.log(`\n[${label}]\n`);

  for await (const chunk of client.stream(api.agents.multiWorkspaceAgent, { input })) {
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
}

await runAgent("write personal workspace and inspect read-only team workspace", [
  "Run these exact workspace checks.",
  "1. In the default personal workspace, write personal.txt containing only personal-alpha.",
  "2. Read personal.txt back with bash and summarize the exact stdout.",
  "3. Confirm the team workspace is configured read-only for sandbox access, so this run does not write team files with bash.",
].join("\n"));

await runAgent("verify writable personal workspace persists", [
  "Run these exact workspace checks from this new conversation.",
  "1. In the default personal workspace, read personal.txt.",
  "2. Report that personal.txt contains personal-alpha.",
  "3. Confirm the team workspace remains read-only in the configuration and should show read-only on the dashboard.",
].join("\n"));
