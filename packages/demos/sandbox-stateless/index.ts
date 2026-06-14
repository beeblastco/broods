/**
 * Example: stateless bash-only sandbox through declarative filthypanty resources.
 */

import { FilthyPantyClient } from "filthy-panty";
import { api } from "./filthypanty/_generated/api";

const harnessUrl =
  process.env.FILTHY_PANTY_AGENT_SERVICE_URL ??
  process.env.FILTHY_PANTY_HARNESS_URL ??
  process.env.AGENT_SERVICE_URL;
const accountSecret =
  process.env.FILTHY_PANTY_ACCOUNT_SECRET ?? process.env.ACCOUNT_SECRET;
const serviceAuthSecret =
  process.env.FILTHY_PANTY_SERVICE_AUTH_SECRET ?? process.env.SERVICE_AUTH_SECRET;
const accountId = process.env.FILTHY_PANTY_ACCOUNT_ID ?? process.env.ACCOUNT_ID;

if (!harnessUrl) {
  throw new Error(
    "sandbox-stateless requires FILTHY_PANTY_HARNESS_URL or FILTHY_PANTY_AGENT_SERVICE_URL for the Lambda Function URL.",
  );
}
if (!accountSecret && !(serviceAuthSecret && accountId)) {
  throw new Error(
    "sandbox-stateless requires FILTHY_PANTY_ACCOUNT_SECRET, or FILTHY_PANTY_SERVICE_AUTH_SECRET plus FILTHY_PANTY_ACCOUNT_ID.",
  );
}

const client = new FilthyPantyClient({
  agentServiceUrl: harnessUrl,
  accountSecret: accountSecret,
  serviceAuthSecret: serviceAuthSecret,
  accountId: accountId,
});

const prompt = [
  "Run this stateless smoke test using ONE bash call per numbered step.",
  "1. In a single bash command, write fib.py that prints the first 10 Fibonacci numbers, then run python3 fib.py.",
  "2. In a single bash command, write fib.js that does the same, then run node fib.js.",
  "3. Run `ls -1` on its own and confirm the files from steps 1-2 are GONE (each call is a fresh container).",
  "4. Summarize stdout and status for every step.",
].join("\n");

for await (const part of client.stream(api.agents.myAgent, { input: prompt })) {
  if (part.type === "text-delta") process.stdout.write(part.text);
}
process.stdout.write("\n");
