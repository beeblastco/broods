import { BroodsClient } from "broods";
import { api } from "./broods/_generated/api";

const client = new BroodsClient();

for await (const chunk of client.stream(api.agents.codingAgent, {
  input:
    "Create hello.txt containing 'hello from HarnessAgent', read it back, and report what you verified.",
})) {
  if (chunk.type === "text-delta") {
    process.stdout.write(chunk.text);
  }
  if (chunk.type === "finish") {
    process.stdout.write(`\n[finished: ${chunk.finishReason}]\n`);
  }
}
