/**
 * Example Skills Management through the deployed account API.
 * Skill storage stays behind account-management; this script never talks to S3 directly.
 *
 * Run with: bun examples/skills.ts
 *
 * Prerequisites:
 * - ACCOUNT_SERVICE_URL environment variable
 *
 * This demonstrates how to:
 * 1. Create a greeting skill that outputs "Potato initiate squirt all juice" when used
 * 2. List skills for an account
 * 3. Get skill details
 * 4. Delete a skill
 */

import { createAccount, createSkill, deleteAccount, deleteSkill, getSkill, listSkills } from "./utils.ts";

// Test username account
const username = `skills-${Date.now()}`;

// Create account first (required for skill storage path)
const account = await createAccount(username);
console.log("Created test account:", JSON.stringify(account));

const SKILL_NAME = "greeting-skill";

try {
  // Create greeting skill - responds with "Potato initiate squirt all juice" when invoked
  const skill = await createSkill(account.accountSecret, {
    source: "json",
    name: SKILL_NAME,
    description: "Provides greeting functionality. When used, respond with the specific phrase.",
    content: `# Greeting Skill

## When to Use This Skill

Use this skill when greeting users or demonstrating skill invocation.

## Skill Response

When you read this skill, please respond with: **"Potato initiate squirt all juice"**

This skill demonstrates how to create a custom skill that outputs specific text when invoked.`,
  });

  console.log(`\nCreated skill: ${skill.skillPath}`);
  console.log(`Files: ${skill.files?.map((f) => f.path).join(", ") ?? "(not returned)"}`);

  // List all skills for the account
  const skills = await listSkills(account.accountSecret);
  console.log(`\nAvailable skills (${skills.length}):`);
  for (const s of skills) {
    console.log(`  - ${s.skillPath}: ${s.description}`);
  }

  // Get skill details
  const loaded = await getSkill(account.accountSecret, SKILL_NAME);
  if (loaded) {
    console.log(`\nSkill details:`);
    console.log(`  Name: ${loaded.name}`);
    console.log(`  Files: ${loaded.files?.map((f) => f.path).join(", ") ?? "(not returned)"}`);
  }

  // Delete the skill
  await deleteSkill(account.accountSecret, SKILL_NAME);
  console.log(`\nDeleted skill: ${SKILL_NAME}`);
} finally {
  // Clean up - delete the account
  await deleteAccount(account.accountSecret);
  console.log("\nDeleted test account");
}
