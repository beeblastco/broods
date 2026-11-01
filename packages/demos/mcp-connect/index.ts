import { BroodsClient, signUserToken } from "broods";
import { api } from "./broods/_generated/api";

// These agents need a signed user token; your backend signs one per signed-in user.
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
