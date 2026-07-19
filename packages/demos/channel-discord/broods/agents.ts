import { defineAgent, defineDiscordChannel, env } from "broods";

export const discord = defineDiscordChannel({
  botToken: env.DISCORD_BOT_TOKEN,
  publicKey: env.DISCORD_PUBLIC_KEY,
  allowedGuildIds: process.env.DISCORD_ALLOWED_GUILD_IDS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean),
});

export const agent = defineAgent({
  name: "discord-channel-agent",
  config: {
    provider: {
      custom: {
        apiKey: env.AI_API_KEY,
        base_url: env.AI_BASE_URL,
      },
    },
    model: {
      provider: "custom",
      modelId: "Qwen3.6-27B",
    },
    agent: {
      system: "You are a concise Discord assistant.",
    },
    channels: [discord],
  },
});
