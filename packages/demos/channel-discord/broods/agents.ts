import { defineAgent, defineDiscordConnection, env } from "broods";

export const discord = defineDiscordConnection({
  channels: ["*"],
  botToken: env("DISCORD_BOT_TOKEN"),
  publicKey: env("DISCORD_PUBLIC_KEY"),
  // Set this and the agent answers only when it is tagged; everything else in
  // the channel is stored as context. Leave it out and it answers everything.
  botUserId: env("DISCORD_BOT_USER_ID"),
  allowedGuildIds: process.env.DISCORD_ALLOWED_GUILD_IDS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean),
});

export const agent = defineAgent({
  name: "discord-channel-agent",
  provider: {
    custom: {
      apiKey: env("AI_API_KEY"),
      base_url: env("AI_BASE_URL"),
    },
  },
  model: {
    provider: "custom",
    modelId: "Qwen3.6-27B",
  },
  agent: {
    system: "You are a concise Discord assistant.",
  },
  connections: [discord],
});
