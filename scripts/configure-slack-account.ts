/**
 * CI configuration helper for the default Slack account.
 * Creates or updates account config, then registers the account-scoped webhook.
 * Skips gracefully if SLACK_BOT_TOKEN is not provided.
 */

import {
    accountManageUrl,
    createScriptAccountRuntimeConfig,
    harnessProcessingUrl,
    optionalScriptEnv,
    requireScriptEnv,
    upsertScriptAccount,
} from "./utils.ts";

const slackBotToken = optionalScriptEnv("SLACK_BOT_TOKEN");
const slackSigningSecret = optionalScriptEnv("SLACK_SIGNING_SECRET");
const allowedChannelIds = optionalScriptEnv("SLACK_ALLOWED_CHANNEL_IDS");

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

const accountManageUrlValue = accountManageUrl();
const harnessProcessingUrlValue = harnessProcessingUrl();
const adminSecret = requireScriptEnv("ADMIN_ACCOUNT_SECRET");
const parsedChannelIds = parseAllowedChannelIds(allowedChannelIds);
const username = process.env.SLACK_ACCOUNT_USERNAME?.trim();
const description = process.env.SLACK_ACCOUNT_DESCRIPTION?.trim();

const account = await upsertSlackAccount();
const webhookUrl = `${harnessProcessingUrlValue}/webhooks/${encodeURIComponent(account.accountId)}/slack`;

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
        accountManageUrl: accountManageUrlValue,
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
