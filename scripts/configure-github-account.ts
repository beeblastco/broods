/**
 * CI configuration helper for the default GitHub account.
 * Creates or updates account config for GitHub App integration.
 * Skips gracefully if GITHUB_APP_ID is not provided.
 */

import { optionalEnv } from "../functions/_shared/env.ts";
import { createScriptAccountRuntimeConfig, upsertScriptAccount } from "./utils.ts";

const githubAppId = optionalEnv("GITHUB_APP_ID");
const githubPrivateKey = optionalEnv("GITHUB_PRIVATE_KEY");
const githubWebhookSecret = optionalEnv("GITHUB_WEBHOOK_SECRET");
const allowedRepos = optionalEnv("GITHUB_ALLOWED_REPOS");

if (!githubAppId) {
  console.warn("Skipping GitHub account setup: GITHUB_APP_ID is not configured");
  process.exit(0);
}

if (!githubPrivateKey) {
  console.warn("Skipping GitHub account setup: GITHUB_PRIVATE_KEY is not configured");
  process.exit(0);
}

if (!githubWebhookSecret) {
  console.warn("Skipping GitHub account setup: GITHUB_WEBHOOK_SECRET is not configured");
  process.exit(0);
}

if (!allowedRepos) {
  console.warn("Skipping GitHub account setup: GITHUB_ALLOWED_REPOS is not configured");
  process.exit(0);
}

const accountServiceUrl = process.env.ACCOUNT_SERVICE_URL!;
const agentServiceUrl = process.env.AGENT_SERVICE_URL!;
const adminSecret = process.env.ADMIN_ACCOUNT_SECRET!;
const parsedRepos = parseAllowedRepos(allowedRepos);
const username = optionalEnv("GITHUB_ACCOUNT_USERNAME")?.trim();
const description = optionalEnv("GITHUB_ACCOUNT_DESCRIPTION")?.trim();

const account = await upsertGitHubAccount();
const webhookUrl = `${agentServiceUrl}/webhooks/${encodeURIComponent(account.accountId)}/github`;

console.log(`Configured GitHub account ${account.accountId}`);
console.log(`Register this webhook URL in your GitHub App: ${webhookUrl}`);

async function upsertGitHubAccount() {
  const config = {
    ...createScriptAccountRuntimeConfig(),
    channels: {
      github: {
        appId: githubAppId,
        privateKey: githubPrivateKey,
        webhookSecret: githubWebhookSecret,
        allowedRepos: parsedRepos,
      },
    },
  };

  return upsertScriptAccount({
    accountServiceUrl,
    adminSecret,
    username,
    description,
    config,
  });
}

function parseAllowedRepos(raw: string): string[] {
  const repos = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (repos.length === 0) {
    throw new Error("GITHUB_ALLOWED_REPOS must contain at least one repository in owner/repo format");
  }

  return repos;
}
