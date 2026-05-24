/**
 * Example streaming direct API skill invocation.
 * Creates a temporary skill through account-management, attaches it to an agent,
 * and streams a harness request that asks the agent to load and use the skill.
 *
 * Run with: bun examples/skill-stream.ts
 *
 * Prerequisites:
 * - ACCOUNT_SERVICE_URL and AGENT_SERVICE_URL environment variables
 * - ACCOUNT_GOOGLE_API_KEY environment variable
 */

import { createAccount, createAgent, createSkill, deleteAccount, streamSSE } from "./utils.ts";

const googleApiKey = process.env.ACCOUNT_GOOGLE_API_KEY!;
const username = `skill-stream-${Date.now()}`;

const account = await createAccount(username);
console.log("Created test account:", JSON.stringify(account));

try {
  const skill = await createSkill(account.accountSecret, {
    source: "json",
    name: "greeting-skill",
    description: "Provides greeting functionality, use when the user greets you. When used, respond with the specific phrase.",
    content: `# Greeting Skill

## When to Use This Skill

Use this skill when greeting users or demonstrating skill invocation.

## Skill Response

When you read this skill, please respond with: **"Potato initiate squirt all juice"**`,
  });
  console.log("\nCreated skill:", JSON.stringify(skill));

  const agent = await createAgent(account.accountSecret, "Skill stream assistant", {
    provider: {
      google: {
        apiKey: googleApiKey,
      },
    },
    model: {
      provider: "google",
      modelId: "gemma-4-31b-it",
    },
    agent: {
      system: "You are a concise assistant.",
    },
    skills: {
      enabled: true,
      allowed: [skill.skillPath],
    },
  });
  console.log("\nCreated skill-enabled agent:", JSON.stringify(agent));

  const body = {
    agentId: agent.agent.agentId,
    eventId: `skill-stream-${Date.now()}`,
    conversationKey: `skill-stream-${Date.now()}`,
    events: [
      {
        role: "user",
        content: [{
          type: "text",
          text: "Hello",
        }],
      },
    ],
  };

  console.log("\nStreaming skill invocation response:\n");
  for await (const chunk of streamSSE(body, account.accountSecret)) {
    process.stdout.write(chunk + "\n");
  }
  console.log();
} finally {
  await deleteAccount(account.accountSecret);
  console.log("\nDeleted test account");
}
