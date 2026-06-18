/**
 * Example: one shared workspace, three agents — a writer (sandbox) plus two read-only
 * readers that differ only in HOW they read via declarative filthy-panty resources.
 */

import { FilthyPantyClient } from "filthy-panty";
import { api } from "./filthypanty/_generated/api";

// Create a client to connect to the Filthy Panty API.
const client = new FilthyPantyClient();

async function runAgent(label: string, agentRef: any, input: string): Promise<void> {
  console.log(`\n[${label}]\n`);

  for await (const chunk of client.stream(agentRef, { input })) {
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

await runAgent("writer seeds a file", api.agents.writer, "Use the write tool to create report.md with the text 'shared via S3'.");

await runAgent("reader-mount reads it back (read-only MOUNT, fresh)", api.agents.readerMount, "Use glob to list **/*.md, then read report.md and return its contents. Try to update file report with new text");

await runAgent("reader-s3 reads it back (S3 DIRECT opt-out)", api.agents.readerS3, "Use glob to list **/*.md, then read report.md and return its contents. Try to update file report with new text");
