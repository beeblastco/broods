/**
 * Example: edit a skill in the sandbox, publish it, then run it from a fresh agent.
 * Demonstrates the staged-skill workflow (issue #40 / #26): one agent loads a skill
 * into the workspace sandbox, creates a script inside the staged bundle, and publishes
 * it back to the account skill bucket; a second agent then loads the same skill and
 * executes the published script. The editor agent is deleted before the runner agent
 * is created, but the published skill is kept so the runner can load it.
 */

import {
  createAccount,
  createAgent,
  createSkill,
  deleteAccount,
  deleteAgent,
  streamSSE,
  requireEnv,
} from "./utils.ts";

const minimaxApiKey = requireEnv("ACCOUNT_MINIMAX_API_KEY");
const username = `skill-edit-${Date.now()}`;

// Shared model + provider settings for both agents.
const provider = { minimax: { apiKey: minimaxApiKey } };
const model = { provider: "minimax", modelId: "MiniMax-M2.7" };

// Workspace must be enabled so load_skill stages the bundle into the sandbox and the
// agent can read, edit, and execute the staged files with bash.
const workspace = {
  enabled: true,
  needsApproval: false,
  storage: { provider: "s3" },
  sandbox: { provider: "lambda", timeout: 30 },
};

const account = await createAccount(username);
console.log("Created test account:", JSON.stringify(account));

try {
  // 1. Create the skill. It ships with instructions only; the editor agent is expected
  //    to add the Python script and publish it back to the bundle.
  const skill = await createSkill(account.secret, {
    source: "json",
    name: "script-runner",
    description: "Bundles and runs a Python greeting script. Use when asked to build or run the script-runner skill.",
    content: `# Script Runner

This skill bundles a Python script under \`scripts/\` and runs it from the workspace sandbox.

## Building the script

If \`scripts/hello.py\` does not exist in the staged skill directory, create it so that running it
prints exactly this single line:

\`\`\`
Hello from the published skill script!
\`\`\`

After creating the file, publish your changes with the publish_skill_changes tool using this
skill's exact path. Do not modify SKILL.md.

## Running the script

To run the skill, execute the staged \`scripts/hello.py\` with \`python3\` and report its stdout.`,
  });
  console.log("\nCreated skill:", JSON.stringify(skill));

  // 2. Editor agent: workspace + skill publishing enabled so it can stage, edit, and publish.
  const editor = await createAgent(account.secret, "Skill editor", {
    provider,
    model,
    agent: {
      system: [
        "You build skill bundles inside the workspace sandbox.",
        "Use the bash tool to create files in the staged skill directory printed by load_skill.",
        "Write real script files; do not use inline execution flags like python -c.",
        "When the skill says to publish, call publish_skill_changes with the skill path.",
        "You do not need to run the python script.",
      ].join("\n"),
    },
    workspace,
    skills: {
      enabled: true,
      allowed: [skill.path],
      // Allow autonomous publishing so the example needs no approval round-trip.
      publish: { enabled: true, needApproval: false },
    },
  });
  console.log("\nCreated editor agent:", JSON.stringify(editor));

  const editBody = {
    agentId: editor.agentId,
    eventId: `skill-edit-build-${Date.now()}`,
    conversationKey: `skill-edit-build-${Date.now()}`,
    events: [{
      role: "user",
      content: [{
        type: "text",
        text: "Load the script-runner skill, build scripts/hello.py exactly as the skill describes, then publish the skill.",
      }],
    }],
  };

  console.log("\n[editor] streaming build + publish:\n");
  for await (const chunk of streamSSE(editBody, account.secret)) {
    process.stdout.write(`${chunk}\n`);
  }

  // 3. Delete the editor agent and its resources, but keep the published skill.
  await deleteAgent(account.secret, editor.agentId);
  console.log("\n\nDeleted editor agent (skill kept)");

  // 4. Runner agent: a fresh agent (fresh workspace namespace) that loads the same skill.
  //    load_skill stages the now-published bundle (including scripts/hello.py) from S3.
  const runner = await createAgent(account.secret, "Skill runner", {
    provider,
    model,
    agent: {
      system: [
        "You run bundled skill scripts inside the workspace sandbox.",
        "Use the bash tool to execute the staged script files; do not use inline execution flags.",
        "Report the exact stdout of the script you run.",
      ].join("\n"),
    },
    workspace,
    skills: {
      enabled: true,
      allowed: [skill.path],
    },
  });
  console.log("\nCreated runner agent:", JSON.stringify(runner));

  const runBody = {
    agentId: runner.agentId,
    eventId: `skill-edit-run-${Date.now()}`,
    conversationKey: `skill-edit-run-${Date.now()}`,
    events: [{
      role: "user",
      content: [{
        type: "text",
        text: "Load the script-runner skill and run its script. Report the exact stdout.",
      }],
    }],
  };

  console.log("\n[runner] streaming script execution:\n");
  for await (const chunk of streamSSE(runBody, account.secret)) {
    process.stdout.write(`${chunk}\n`);
  }
  console.log();
} finally {
  // Full cleanup: deleting the account removes both agents and the skill bundle.
  await deleteAccount(account.secret);
  console.log("\nDeleted test account");
}
