import { BroodsClient, signUserToken } from "broods";
import { api } from "./broods/_generated/api";

// These agents need a signed user token; your backend signs one per signed-in user.
const client = new BroodsClient({
  userToken: () => signUserToken({ userId: "demo-user" }),
});

const run = await client.runAsync(api.agents.structuredAssistant, {
  input:
    "What is the newest model release from OpenAI? Provide a concise answer and suggest follow-up actions.",
});

console.log("Run id:", run.runId);
console.log("Status URL:", run.statusUrl);

const status = await run.wait();

console.log(JSON.stringify(status, null, 2));
