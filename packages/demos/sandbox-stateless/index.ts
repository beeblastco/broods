/**
 * Example: stateless bash-only sandbox through declarative filthypanty resources.
 */

import { FilthyPantyClient } from "filthy-panty";
import { api } from "./filthypanty/_generated/api";

const client = new FilthyPantyClient();

const prompt = [
  "Run this stateless smoke test using ONE bash call per numbered step.",
  "1. In a single bash command, write fib.py that prints the first 10 Fibonacci numbers, then run python3 fib.py.",
  "2. In a single bash command, write fib.js that does the same, then run node fib.js.",
  "3. Run `ls -1` on its own and confirm the files from steps 1-2 are GONE (each call is a fresh container).",
  "4. Summarize stdout and status for every step.",
].join("\n");

for await (const part of client.stream(api.agents.compute, { input: prompt })) {
  if (part.type === "text-delta") process.stdout.write(part.text);
}
process.stdout.write("\n");
