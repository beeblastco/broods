/**
 * Example: Vercel Sandbox provider with persistent lifecycle hooks.
 */

import {
  createAccount,
  createAgent,
  createSandbox,
  createWorkspace,
  deleteAccount,
  streamSSE,
  requireEnv,
} from "filthy-panty";

const minimaxApiKey = requireEnv("ACCOUNT_MINIMAX_API_KEY");
const vercelToken = requireEnv("VERCEL_TOKEN");
const vercelTeamId = requireEnv("VERCEL_TEAM_ID");
const vercelProjectId = requireEnv("VERCEL_PROJECT_ID");
const username = `sandbox-vercel-${Date.now()}`;

const account = await createAccount(username);

const sandbox = await createSandbox(account.secret, "vercel-sandbox", {
  provider: "vercel",
  persistent: true,
  network: {
    mode: "restricted",
    allowDomains: ["api.github.com", "registry.npmjs.org"],
  },
  permissionMode: "bypass",
  timeout: 120,
  outputLimitBytes: 65536,
  envVars: {
    SANDBOX_SMOKE_VAR: "sandbox-env-ok",
  },
  onCreate: [
    "printf 'created\\n' > .fp-vercel-hook.txt",
  ],
  onResume: [
    "printf 'resumed\\n' >> .fp-vercel-hook.txt",
  ],
  options: {
    token: vercelToken,
    teamId: vercelTeamId,
    projectId: vercelProjectId,
    runtime: "node24",
    workspaceRoot: "/mnt/workspaces",
  },
});

const workspace = await createWorkspace(account.secret, "vercel-project", {
  storage: { provider: "vercel" },
  harness: { enabled: true },
});

const agent = await createAgent(account.secret, "Vercel sandbox assistant", {
  provider: {
    minimax: {
      apiKey: minimaxApiKey,
    },
  },
  model: {
    provider: "minimax",
    modelId: "MiniMax-M3",
  },
  agent: {
    system: [
      "You are testing a persistent Vercel Sandbox.",
      "Use the bash tool for each numbered step.",
      "Report stdout and status for every run.",
    ].join("\n"),
  },
  sandbox: sandbox.sandboxId,
  workspaces: [{ name: "vercel-project", workspaceId: workspace.workspaceId }],
});

console.log("Created test account:", JSON.stringify(account));
console.log("Created sandbox:", JSON.stringify(sandbox));
console.log("Created workspace:", JSON.stringify(workspace));
console.log("Created test agent:", JSON.stringify(agent));

try {
  const body = {
    agentId: agent.agentId,
    eventId: `sandbox-vercel-${Date.now()}`,
    conversationKey: `sandbox-vercel-${Date.now()}`,
    events: [
      {
        role: "user",
        content: [{
          type: "text",
          text: [
            "Run this Vercel Sandbox smoke test using separate bash calls.",
            "1. Print the contents of .fp-vercel-hook.txt and echo shell:$SANDBOX_SMOKE_VAR.",
            "2. Write hook-check.txt containing the hook file contents, then read it back.",
            "3. Start a background job with bash background:true that runs: sleep 2; echo vercel-bg-done.",
            "4. Poll async_status for the returned statusId until it is completed, then fetch logs.",
            "5. Summarize the hook side effects and the background job result.",
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
