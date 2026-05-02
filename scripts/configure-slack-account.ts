/**
 * CI configuration helper for the default Slack account.
 * Creates or updates account config, then registers the account-scoped webhook.
 */

import {
    accountManageUrl,
    createScriptAccountRuntimeConfig,
    harnessProcessingUrl,
    requireScriptEnv,
    upsertScriptAccount,
} from "./utils.ts";

const accountManageUrlValue = accountManageUrl();
const harnessProcessingUrlValue = harnessProcessingUrl();
const adminSecret = requireScriptEnv("ADMIN_ACCOUNT_SECRET");
const slackBotToken = requireScriptEnv("SLACK_BOT_TOKEN");
const slackSigningSecret = requireScriptEnv("SLACK_SIGNING_SECRET");
const allowedChannelIds = parseAllowedChannelIds(requireScriptEnv("SLACK_ALLOWED_CHANNEL_IDS"));
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
                allowedChannelIds,
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
