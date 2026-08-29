/**
 * Example: ask the agent a question that routes through its connected MCP
 * server. Run `broods deploy` first so the server registration and agent sync.
 */

import { BroodsClient } from "broods";
import { api } from "./broods/_generated/api";

const client = new BroodsClient();

const run = await client.runAsync(api.agents.assistant, {
  input: "What does the search server say? Use your tools.",
});
const status = await run.wait();

console.log("Status:", status.status);
console.log("Response:", status.response);
if (status.error) console.error("Error:", status.error);
