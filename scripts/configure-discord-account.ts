/**
 * CI configuration helper for the default Discord account.
 * Creates or updates account and agent config, then registers the agent-scoped webhook.
 * Skips gracefully if DISCORD_BOT_TOKEN is not provided.
 */

import { optionalEnv } from "../functions/_shared/env.ts";
import { accountServiceUrl, agentServiceUrl, createScriptAgentConfig, upsertScriptAccount } from "./utils.ts";

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

const accountServiceUrlValue = accountServiceUrl();
const agentServiceUrlValue = agentServiceUrl();
const adminSecret = process.env.ADMIN_ACCOUNT_SECRET!;
const parsedGuildIds = parseAllowedGuildIds(allowedGuildIds);
const username = optionalEnv("INTEGRATIONS_ACCOUNT_USERNAME")?.trim() ?? "integrations-default";
const description = optionalEnv("INTEGRATIONS_ACCOUNT_DESCRIPTION")?.trim();
const agentName = optionalEnv("DISCORD_AGENT_NAME")?.trim() ?? "discord-default";
const agentDescription = optionalEnv("DISCORD_AGENT_DESCRIPTION")?.trim();

const { account, agent } = await upsertDiscordAccount();
const webhookUrl = `${agentServiceUrlValue}/webhooks/${encodeURIComponent(account.accountId)}/${encodeURIComponent(agent.agentId)}/discord`;

console.log(`Configured Discord account ${account.accountId} and agent ${agent.agentId}`);
console.log(`Register this URL in your Discord application: ${webhookUrl}`);

async function upsertDiscordAccount() {
    const config = {
        ...createScriptAgentConfig(),
        channels: {
            discord: {
                botToken: discordBotToken,
                publicKey: discordPublicKey,
                allowedGuildIds: parsedGuildIds,
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
