/**
 * Example: ask the agent a question that routes through its connected MCP
 * server. Run `broods deploy` first so the server registration and agent sync.
 */

import { BroodsClient, signUserToken } from "broods";
import { api } from "./broods/_generated/api";

// The demo's agents require a signed user token beside the runtime key.
// Your backend signs one per signed-in user; here one demo user stands in.
const client = new BroodsClient({
  userToken: () => signUserToken({ userId: "demo-user" }),
});

const run = await client.runAsync(api.agents.assistant, {
  input: "What does the search server say? Use your tools.",
});
const status = await run.wait();

console.log("Status:", status.status);
console.log("Response:", status.response);
if (status.error) console.error("Error:", status.error);
