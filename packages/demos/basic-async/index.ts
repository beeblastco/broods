/**
 * Example: start an async run and poll its status via the SDK.
 */

import { FilthyPantyClient } from "filthy-panty";
import { api } from "./filthypanty/_generated/api";

const client = new FilthyPantyClient();

const run = await client.runAsync(api.agents.search, {
  input: "Search the web for the latest weather in Hanoi.",
});

console.log("Async status id:", run.statusId);
console.log("Status URL:", run.statusUrl);

const status = await run.wait();

console.log("Status:", status.status);
console.log("Response:", formatResponse(status.response));
if (status.error) console.error("Error:", status.error);

function formatResponse(response: unknown): string {
  return typeof response === "string" ? response : JSON.stringify(response, null, 2);
}
