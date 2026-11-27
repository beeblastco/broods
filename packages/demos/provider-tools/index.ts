import { BroodsClient, signUserToken } from "broods";
import { api } from "./broods/_generated/api";

const client = new BroodsClient({
  userToken: () => signUserToken({ userId: "demo-user" }),
});

for await (const chunk of client.stream(api.agents.claudeAgent, {
  input:
    "Search the web for today's top AI news, save a three-line summary to news.md, then cat it.",
})) {
  if (chunk.type === "text-delta") process.stdout.write(chunk.text);
  if (chunk.type === "tool-call") console.log(`\n[${chunk.toolName}]`);
}
process.stdout.write("\n");
