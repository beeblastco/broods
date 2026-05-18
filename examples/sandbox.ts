/**
 * Example workspace sandbox execution.
 */

import { createAccount, createAgent, deleteAccount, streamSSE } from "./utils.ts";

const googleApiKey = requireEnv("ACCOUNT_GOOGLE_API_KEY");
const modelId = process.env.ACCOUNT_MODEL_ID ?? "gemma-4-31b-it";
const sandboxProvider = process.env.SANDBOX_PROVIDER ?? "lambda";
const username = `sandbox-${Date.now()}`;

const account = await createAccount(username);
const agent = await createAgent(account.accountSecret, "Sandbox assistant", {
  provider: {
    google: {
      apiKey: googleApiKey,
    },
  },
  model: {
    provider: "google",
    modelId,
    temperature: 0,
  },
  agent: {
    system: [
      "You are testing the workspace sandbox.",
      "Use the filesystem tool to write files first, then execute only those files.",
      "Do not use inline execution such as node -e or python -c.",
      "After running the files, summarize stdout and status for each run.",
    ].join("\n"),
  },
  workspace: {
    enabled: true,
    needsApproval: false,
    memory: {
      enabled: false,
    },
    filesystem: {
      enabled: true,
    },
    sandbox: {
      enabled: true,
      provider: sandboxProvider,
      timeout: 30,
      memoryLimit: 128,
      outputLimitBytes: 65536,
    },
    tasks: {
      enabled: false,
    },
  },
});

console.log("Created test account:", JSON.stringify(account));
console.log("Created test agent:", JSON.stringify(agent));

try {
  const body = {
    agentId: agent.agent.agentId,
    eventId: `sandbox-${Date.now()}`,
    conversationKey: `sandbox-${Date.now()}`,
    events: [
      {
        role: "user",
        content: [{
          type: "text",
          text: [
            "Run this exact sandbox smoke test.",
            "",
            "1. Write /sandbox-demo.js with JavaScript that prints JSON.stringify({ language: 'javascript', answer: 21 * 2 }).",
            "2. Run node /sandbox-demo.js.",
            "3. Write /sandbox-demo.py with Python that prints {'language': 'python', 'answer': 6 * 7}.",
            "4. Run python3 /sandbox-demo.py.",
            "5. Return the stdout and status objects from both runs.",
          ].join("\n"),
        }],
      },
    ],
  };

  for await (const chunk of streamSSE(body, account.accountSecret)) {
    process.stdout.write(`${chunk}\n\n`);
  }
} finally {
  await deleteAccount(account.accountSecret);
  console.log("\n\nDeleted test account");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
