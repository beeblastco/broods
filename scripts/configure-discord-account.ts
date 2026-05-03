/**
 * CI configuration helper for the default Discord account.
 * Creates or updates account config, then registers the account-scoped webhook.
 * Skips gracefully if DISCORD_BOT_TOKEN is not provided.
 */

import { optionalEnv } from "../functions/_shared/env.ts";
import { createScriptAccountRuntimeConfig, upsertScriptAccount } from "./utils.ts";

const discordBotToken = optionalEnv("DISCORD_BOT_TOKEN");
const discordPublicKey = optionalEnv("DISCORD_PUBLIC_KEY");
const allowedGuildIds = optionalEnv("DISCORD_ALLOWED_GUILD_IDS");

if (!discordBotToken) {
  console.warn("Skipping Discord account setup: DISCORD_BOT_TOKEN is not configured");
  process.exit(0);
}

if (!discordPublicKey) {
  console.warn("Skipping Discord account setup: DISCORD_PUBLIC_KEY is not configured");
  process.exit(0);
}

if (!allowedGuildIds) {
  console.warn("Skipping Discord account setup: DISCORD_ALLOWED_GUILD_IDS is not configured");
  process.exit(0);
}

const accountServiceUrl = process.env.ACCOUNT_SERVICE_URL!;
const agentServiceUrl = process.env.AGENT_SERVICE_URL!;
const adminSecret = process.env.ADMIN_ACCOUNT_SECRET!;
const parsedGuildIds = parseAllowedGuildIds(allowedGuildIds);
const username = optionalEnv("DISCORD_ACCOUNT_USERNAME")?.trim();
const description = optionalEnv("DISCORD_ACCOUNT_DESCRIPTION")?.trim();

const account = await upsertDiscordAccount();
const webhookUrl = `${agentServiceUrl}/webhooks/${encodeURIComponent(account.accountId)}/discord`;

console.log(`Configured Discord account ${account.accountId}`);
console.log(`Register this URL in your Discord application: ${webhookUrl}`);

async function upsertDiscordAccount() {
    const config = {
        ...createScriptAccountRuntimeConfig(),
        channels: {
            discord: {
                botToken: discordBotToken,
                publicKey: discordPublicKey,
                allowedGuildIds: parsedGuildIds,
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
