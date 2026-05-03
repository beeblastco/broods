/**
 * CI configuration helper for the default Slack account.
 * Creates or updates account config, then registers the account-scoped webhook.
 * Skips gracefully if SLACK_BOT_TOKEN is not provided.
 */

import { optionalEnv } from "../functions/_shared/env.ts";
import { createScriptAccountRuntimeConfig, upsertScriptAccount } from "./utils.ts";

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

const accountServiceUrl = process.env.ACCOUNT_SERVICE_URL!;
const agentServiceUrl = process.env.AGENT_SERVICE_URL!;
const adminSecret = process.env.ADMIN_ACCOUNT_SECRET!;
const parsedChannelIds = parseAllowedChannelIds(allowedChannelIds);
const username = optionalEnv("SLACK_ACCOUNT_USERNAME")?.trim();
const description = optionalEnv("SLACK_ACCOUNT_DESCRIPTION")?.trim();

const account = await upsertSlackAccount();
const webhookUrl = `${agentServiceUrl}/webhooks/${encodeURIComponent(account.accountId)}/slack`;

console.log(`Configured Slack account ${account.accountId}`);
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
        accountServiceUrl,
        adminSecret,
        username,
        description,
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
