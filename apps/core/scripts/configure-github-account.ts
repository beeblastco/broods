/**
 * CI configuration helper for the default GitHub account.
 * Creates or updates account and agent config for GitHub App integration.
 * Skips gracefully if GITHUB_APP_ID is not provided.
 */

import { optionalEnv } from "../functions/_shared/env.ts";
import { accountServiceUrl, agentServiceUrl, createScriptAgentConfig, upsertScriptAccount } from "./utils.ts";

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

const accountServiceUrlValue = accountServiceUrl();
const agentServiceUrlValue = agentServiceUrl();
const adminSecret = process.env.ADMIN_ACCOUNT_SECRET!;
const parsedRepos = parseAllowedRepos(allowedRepos);
const username = optionalEnv("INTEGRATIONS_ACCOUNT_USERNAME")?.trim() ?? "integrations-default";
const description = optionalEnv("INTEGRATIONS_ACCOUNT_DESCRIPTION")?.trim();
const agentName = optionalEnv("GITHUB_AGENT_NAME")?.trim() ?? "github-default";
const agentDescription = optionalEnv("GITHUB_AGENT_DESCRIPTION")?.trim();

const { account, agent } = await upsertGitHubAccount();
const webhookUrl = `${agentServiceUrlValue}/webhooks/${encodeURIComponent(account.accountId)}/${encodeURIComponent(agent.agentId)}/github`;

console.log(`Configured GitHub account ${account.accountId} and agent ${agent.agentId}`);
console.log(`Register this webhook URL in your GitHub App: ${webhookUrl}`);

async function upsertGitHubAccount() {
  const config = {
    ...createScriptAgentConfig(),
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
    accountServiceUrl: accountServiceUrlValue,
    adminSecret,
    username,
    description,
    agentName,
    agentDescription,
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
