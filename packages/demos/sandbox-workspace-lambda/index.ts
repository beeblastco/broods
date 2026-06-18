/**
 * Example: lambda sandbox + workspace via declarative filthy-panty resources.
 */

import { FilthyPantyClient } from "filthy-panty";
import { api } from "./filthypanty/_generated/api";

// Create a client to connect to the Filthy Panty API.
const client = new FilthyPantyClient();

// Stream the response from the agent and print it to stdout.
for await (const chunk of client.stream(api.agents.sandboxAgent, {
  input: [
    "Run this exact native mounted sandbox smoke test, covering env vars and outbound internet.",
    "",
    "Env var check (the sandbox configured SANDBOX_SMOKE_VAR=sandbox-env-ok):",
    "1. Run the bash command: echo \"shell:$SANDBOX_SMOKE_VAR\".",
    "2. Use the write tool to create env.py that prints `python:` followed by os.environ['SANDBOX_SMOKE_VAR'], then run python3 env.py with bash.",
    "3. Use the write tool to create env.js that prints `node:` followed by process.env.SANDBOX_SMOKE_VAR, then run node env.js with bash.",
    "4. Confirm all three print sandbox-env-ok.",
    "",
    "Outbound-internet check:",
    "5. Write weather.py with Python that uses urllib.request to GET https://api.open-meteo.com/v1/forecast?latitude=37.7749&longitude=-122.4194&current_weather=true&temperature_unit=fahrenheit and prints the JSON response.",
    "6. Run python3 weather.py with bash.",
    "7. Write weather.js with JavaScript that calls fetch on the same URL and prints await response.text().",
    "8. Run node weather.js with bash.",
    "9. Return the stdout and status from every run.",
  ].join("\n"),
})) {
    switch (chunk.type) {
      case "reasoning-delta":
        process.stdout.write(`\x1b[90m${chunk.text}\x1b[0m`);
        break;
      case "reasoning-end":
        process.stdout.write(`\n\n`);
        break;
      case "text-delta":
        process.stdout.write(`\x1b[32m${chunk.text}\x1b[0m`);
        break;
      case "text-end":
        process.stdout.write(`\n\n`);
        break;
      case "tool-input-delta":
        process.stdout.write(`\x1b[36m${chunk.delta}\x1b[0m`);
        break;
      case "tool-call":
        process.stdout.write(`\n\x1b[36m[Tool Call: ${chunk.toolName}]\x1b[0m\n`);
        break;
      case "tool-result":
        process.stdout.write(`\n\x1b[35m[Tool Result: ${JSON.stringify(chunk.output)}]\x1b[0m\n`);
        break;
      case "finish":
        process.stdout.write(`\n\x1b[37m[Finished: ${chunk.finishReason}]\x1b[0m\n`);
        break;
    }
}
