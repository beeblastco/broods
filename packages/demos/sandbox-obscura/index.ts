/**
 * Example: browse the web from a lambda sandbox on the Obscura image with the
 * built-in `browse` tool. Exits 1 unless browse ran in both modes without an
 * error, so it doubles as a smoke test for a stage.
 */

import { BroodsClient } from "broods";
import { api } from "./broods/_generated/api";

const client = new BroodsClient();
const calls: string[] = [];
const failed: string[] = [];

for await (const chunk of client.stream(api.agents.browser, {
  input: [
    "1. Use the browse tool in markdown mode on https://example.com and tell me the page's heading.",
    "2. Then use the browse tool in links mode on the same page and list its links.",
  ].join("\n"),
})) {
  switch (chunk.type) {
    case "text-delta":
      process.stdout.write(`\x1b[32m${chunk.text}\x1b[0m`);
      break;
    case "tool-call":
      calls.push(chunk.toolName);
      process.stdout.write(`\n\x1b[36m[Tool Call: ${chunk.toolName}]\x1b[0m\n`);
      break;
    case "tool-result":
      process.stdout.write(
        `\x1b[35m[Tool Result: ${JSON.stringify(chunk.output).slice(0, 300)}]\x1b[0m\n`,
      );
      break;
    case "tool-error":
      failed.push(chunk.toolName);
      process.stdout.write(`\x1b[31m[Tool Error: ${chunk.toolName}]\x1b[0m\n`);
      break;
    case "finish":
      process.stdout.write(
        `\n\x1b[37m[Finished: ${chunk.finishReason}]\x1b[0m\n`,
      );
      break;
  }
}

const browseCalls = calls.filter((name): boolean => name === "browse");
if (browseCalls.length < 2 || failed.length > 0) {
  console.error(
    `smoke test failed: tools called ${calls.join(", ") || "none"}; errors ${failed.join(", ") || "none"}`,
  );
  process.exit(1);
}
console.log("smoke test passed: browse answered in markdown and links mode");
