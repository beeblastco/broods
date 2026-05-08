/**
 * CI configuration helper for the default Slack account.
 * Creates or updates account and agent config, then registers the agent-scoped webhook.
 * Skips gracefully if SLACK_BOT_TOKEN is not provided.
 */

import { optionalEnv } from "../functions/_shared/env.ts";
import { accountServiceUrl, agentServiceUrl, createScriptAccountRuntimeConfig, upsertScriptAccount } from "./utils.ts";

const slackBotToken = optionalEnv("SLACK_BOT_TOKEN");
const slackSigningSecret = optionalEnv("SLACK_SIGNING_SECRET");
const allowedChannelIds = optionalEnv("SLACK_ALLOWED_CHANNEL_IDS");

if (!slackBotToken) {
  console.warn("Skipping Slack account setup: SLACK_BOT_TOKEN is not configured");
  process.exit(0);
}

if (!slackSigningSecret) {
  console.warn("Skipping Slack account setup: SLACK_SIGNING_SECRET is not configured");
  process.exit(0);
}

if (!allowedChannelIds) {
  console.warn("Skipping Slack account setup: SLACK_ALLOWED_CHANNEL_IDS is not configured");
  process.exit(0);
}

const accountServiceUrlValue = accountServiceUrl();
const agentServiceUrlValue = agentServiceUrl();
const adminSecret = process.env.ADMIN_ACCOUNT_SECRET!;
const parsedChannelIds = parseAllowedChannelIds(allowedChannelIds);
const username = optionalEnv("SLACK_ACCOUNT_USERNAME")?.trim();
const description = optionalEnv("SLACK_ACCOUNT_DESCRIPTION")?.trim();
const agentName = optionalEnv("SLACK_AGENT_NAME")?.trim() ?? "slack-default";
const agentDescription = optionalEnv("SLACK_AGENT_DESCRIPTION")?.trim() ?? description;

const { account, agent } = await upsertSlackAccount();
const webhookUrl = `${agentServiceUrlValue}/webhooks/${encodeURIComponent(account.accountId)}/${encodeURIComponent(agent.agentId)}/slack`;

console.log(`Configured Slack account ${account.accountId} and agent ${agent.agentId}`);
console.log(`Register this URL in your Slack app's Event Subscriptions: ${webhookUrl}`);

async function upsertSlackAccount() {
    const config = {
        ...createScriptAccountRuntimeConfig(),
        channels: {
            slack: {
                botToken: slackBotToken,
                signingSecret: slackSigningSecret,
                allowedChannelIds: parsedChannelIds,
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

function parseAllowedChannelIds(raw: string): string[] {
    const ids = raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

    if (ids.length === 0) {
        throw new Error("SLACK_ALLOWED_CHANNEL_IDS must contain at least one Slack channel id");
    }

    return ids;
}
