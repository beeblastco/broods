/**
 * CI configuration helper for the default Discord account.
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
const discordBotToken = requireScriptEnv("DISCORD_BOT_TOKEN");
const discordPublicKey = requireScriptEnv("DISCORD_PUBLIC_KEY");
const allowedGuildIds = parseAllowedGuildIds(requireScriptEnv("DISCORD_ALLOWED_GUILD_IDS"));
const username = process.env.DISCORD_ACCOUNT_USERNAME?.trim();
const description = process.env.DISCORD_ACCOUNT_DESCRIPTION?.trim();

const account = await upsertDiscordAccount();
const webhookUrl = `${harnessProcessingUrlValue}/webhooks/${encodeURIComponent(account.accountId)}/discord`;

console.log(`Configured Discord account ${account.accountId}`);
console.log(`Register this URL in your Discord application: ${webhookUrl}`);

async function upsertDiscordAccount() {
    const config = {
        ...createScriptAccountRuntimeConfig(),
        channels: {
            discord: {
                botToken: discordBotToken,
                publicKey: discordPublicKey,
                allowedGuildIds,
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

function parseAllowedGuildIds(raw: string): string[] {
    const ids = raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

    if (ids.length === 0) {
        throw new Error("DISCORD_ALLOWED_GUILD_IDS must contain at least one Discord guild id");
    }

    return ids;
}
