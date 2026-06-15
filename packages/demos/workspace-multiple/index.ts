/**
 * Example: one agent with two named S3-backed workspaces via declarative filthy-panty resources.
 */

import { FilthyPantyClient } from "filthy-panty";
import { api } from "./filthypanty/_generated/api";

// Create a client to connect to the Filthy Panty API.
const client = new FilthyPantyClient({
  host: process.env.FILTHY_PANTY_HOST,
  apiKey: process.env.FILTHY_PANTY_API_KEY!,
});

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

await runAgent("create files in two named workspaces", [
  "Run these exact workspace checks.",
  "1. In the default personal workspace, write personal.txt containing only personal-alpha.",
  "2. In the team workspace, write team.txt containing only team-shared.",
  "3. Read both files back with bash and summarize the exact stdout.",
].join("\n"));

await runAgent("verify both workspaces persist by workspaceId", [
  "Run these exact workspace checks from this new conversation.",
  "1. In the default personal workspace, read personal.txt.",
  "2. In the team workspace, read team.txt.",
  "3. Report that personal.txt contains personal-alpha and team.txt contains team-shared.",
].join("\n"));
