/**
 * Example: a sandbox with NO workspace — stateless, bash-only.
 *
 * An agent that references a sandbox but no workspace gets ONLY the `bash` tool. Each call
 * is a fresh ephemeral container with no persistence, so read/write/edit/glob/grep are not
 * exposed (they assume persisted files). The agent must write+run inside a single command.
 * This is the fastest, cheapest sandbox shape — good for one-shot compute with no saved output.
 */

import {
  createAccount,
  createAgent,
  createSandbox,
  deleteAccount,
  streamSSE,
  requireEnv,
} from "./utils.ts";

const googleApiKey = requireEnv("ACCOUNT_GOOGLE_API_KEY");
const username = `sandbox-stateless-${Date.now()}`;

const account = await createAccount(username);

// Sandbox only — no workspace is created or referenced below.
const sandbox = await createSandbox(account.secret, "stateless-sandbox", {
  provider: "lambda",
  internet: false,
  permissionMode: "bypass",
  timeout: 60,
});

const agent = await createAgent(account.secret, "Stateless compute assistant", {
  provider: {
    google: { apiKey: googleApiKey },
  },
  model: {
    provider: "google",
    modelId: "gemma-4-31b-it",
    temperature: 0,
  },
  agent: {
    system: [
      "You only have the bash tool — there is no persistent workspace.",
      "Each bash call is a fresh container, so write any files and run them in the SAME command.",
      "Report stdout and status for every run.",
    ].join("\n"),
  },
  sandbox: sandbox.sandboxId,
  // No `workspaces` => stateless, bash-only tool surface.
});

console.log("Created test account:", JSON.stringify(account));
console.log("Created sandbox:", JSON.stringify(sandbox));
console.log("Created test agent:", JSON.stringify(agent));

try {
  const body = {
    agentId: agent.agentId,
    eventId: `sandbox-stateless-${Date.now()}`,
    conversationKey: `sandbox-stateless-${Date.now()}`,
    events: [
      {
        role: "user",
        content: [{
          type: "text",
          text: [
            "Run this stateless smoke test using ONE bash call per numbered step.",
            "1. In a single bash command, write fib.py that prints the first 10 Fibonacci numbers, then run python3 fib.py.",
            "2. In a single bash command, write fib.js that does the same, then run node fib.js.",
            "3. Run `ls -1` on its own and confirm the files from steps 1-2 are GONE (each call is a fresh container).",
            "4. Summarize stdout and status for every step.",
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
