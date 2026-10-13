/**
 * Example: start an async run and poll its status via the SDK.
 */

import { BroodsClient, signUserToken } from "broods";
import { api } from "./broods/_generated/api";

// The demo's agents require a signed user token beside the runtime key.
// Your backend signs one per signed-in user; here one demo user stands in.
const client = new BroodsClient({
  userToken: () => signUserToken({ userId: "demo-user" }),
});

const run = await client.runAsync(api.agents.search, {
  input: "Search the web for the latest weather in Hanoi.",
});

console.log("Run id:", run.runId);
console.log("Status URL:", run.statusUrl);

const status = await run.wait();

console.log("Status:", status.status);
console.log("Response:", formatResponse(status.response));
if (status.error) console.error("Error:", status.error);

function formatResponse(response: unknown): string {
  return typeof response === "string"
    ? response
    : JSON.stringify(response, null, 2);
}
