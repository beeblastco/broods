/**
 * Discord slash command sync. Run when ENABLE_DISCORD_INTEGRATION=true in CI
 * Register shared command metadata with Discord through the application command HTTP API.
 */

import {
  getDiscordCommandRegistrations,
} from "../functions/_shared/commands.ts";
import { optionalEnv, requireEnv } from "../functions/_shared/env.ts";
import { logInfo } from "../functions/_shared/log.ts";

interface RegisteredDiscordCommand {
  id: string;
  name: string;
}

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

const DISCORD_APPLICATION_ID = requireEnv("DISCORD_APPLICATION_ID");
const DISCORD_SYNC_GUILD_ID = optionalEnv("DISCORD_SYNC_GUILD_ID");
const DISCORD_BOT_TOKEN = requireEnv("DISCORD_BOT_TOKEN");

const route = DISCORD_SYNC_GUILD_ID
  ? `/applications/${DISCORD_APPLICATION_ID}/guilds/${DISCORD_SYNC_GUILD_ID}/commands`
  : `/applications/${DISCORD_APPLICATION_ID}/commands`;

const response = await fetch(`${DISCORD_API_BASE_URL}${route}`, {
  method: "PUT",
  headers: {
    "Authorization": `Bot ${DISCORD_BOT_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(
    getDiscordCommandRegistrations(DISCORD_SYNC_GUILD_ID ? "guild" : "global"),
  ),
});

if (!response.ok) {
  const body = await response.text();
  throw new Error(`Discord command sync failed (${response.status}): ${body}`);
}

const commands = await response.json() as RegisteredDiscordCommand[];

logInfo("Discord slash commands synced", {
  scope: DISCORD_SYNC_GUILD_ID ? "guild" : "global",
  count: commands.length,
  names: commands.map((command) => command.name),
});

process.stdout.write(JSON.stringify({
  scope: DISCORD_SYNC_GUILD_ID ? "guild" : "global",
  route,
  commands: commands.map((command) => ({
    id: command.id,
    name: command.name,
  })),
}, null, 2) + "\n");
