/**
 * Example workspace sandbox execution.
 */

import { createAccount, createAgent, deleteAccount, streamSSE, requireEnv } from "./utils.ts";

const googleApiKey = requireEnv("ACCOUNT_GOOGLE_API_KEY");
const username = `sandbox-${Date.now()}`;

const account = await createAccount(username);
const agent = await createAgent(account.secret, "Sandbox assistant", {
  provider: {
    google: {
      apiKey: googleApiKey,
    },
  },
  model: {
    provider: "google",
    modelId: "gemma-4-31b-it",
    temperature: 0,
  },
  agent: {
    system: [
      "You are testing the workspace sandbox.",
      "The sandbox uses a native mounted workspace filesystem.",
      "Use the bash tool to write source files and data files first, then execute only file-based scripts. Node inline flags such as `node -e` are not supported.",
      "Sandboxed code should use normal relative file APIs from the workspace root.",
      "Do not use inline execution such as node -e or python -c.",
      "After running files, summarize stdout, generated files, and status for each run.",
    ].join("\n"),
  },
  workspace: {
    enabled: true,
    needsApproval: false,
    storage: {
      provider: "s3",
    },
    sandbox: {
      provider: "lambda",
      timeout: 30,
      outputLimitBytes: 65536,
      options: {
        networkAccess: "public",
      },
    },
  },
});

console.log("Created test account:", JSON.stringify(account));
console.log("Created test agent:", JSON.stringify(agent));

try {
  const body = {
    agentId: agent.agentId,
    eventId: `sandbox-${Date.now()}`,
    conversationKey: `sandbox-${Date.now()}`,
    events: [
      {
        role: "user",
        content: [{
          type: "text",
          text: [
            "Run this exact native mounted sandbox outbound-internet smoke test.",
            "",
            "1. Write /weather.py with Python that uses urllib.request to GET https://api.open-meteo.com/v1/forecast?latitude=37.7749&longitude=-122.4194&current_weather=true&temperature_unit=fahrenheit and prints the JSON response.",
            "2. Run python3 /weather.py.",
            "3. Write /weather.js with JavaScript that calls fetch on the same URL and prints await response.text().",
            "4. Run node /weather.js.",
            "5. Return the stdout and status objects from both runs.",
          ].join("\n"),
        }],
      },
    ],
  };

  for await (const chunk of streamSSE(body, account.secret)) {
    process.stdout.write(`${chunk}\n\n`);
  }
} finally {
  await deleteAccount(account.secret);
  console.log("\n\nDeleted test account");
}
