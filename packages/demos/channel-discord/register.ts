const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_SYNC_GUILD_ID;
if (!applicationId || !botToken) throw new Error("DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN are required");
const route = guildId
  ? `/applications/${applicationId}/guilds/${guildId}/commands`
  : `/applications/${applicationId}/commands`;
const commands = [
  { name: "new", description: "Clear conversation context and start fresh" },
  { name: "clear", description: "Clear conversation context and start fresh" },
  { name: "help", description: "Show available commands" },
];
const response = await fetch(`https://discord.com/api/v10${route}`, {
  method: "PUT",
  headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
  body: JSON.stringify(commands),
});
if (!response.ok) throw new Error(`Discord command sync failed: ${response.status} ${await response.text()}`);
console.log(`Registered Discord commands at ${route}`);
