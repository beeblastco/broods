/**
 * Example: async run with structured output polling.
 */

import { FilthyPantyClient } from "filthy-panty";
import { api } from "./filthypanty/_generated/api";

const client = new FilthyPantyClient();

const run = await client.runAsync(api.agents.structuredAssistant, {
  input: "What is the newest model release from OpenAI? Provide a concise answer and suggest follow-up actions.",
});

console.log("Async status id:", run.statusId);
console.log("Status URL:", run.statusUrl);

const status = await run.wait();

console.log(JSON.stringify(status, null, 2));
