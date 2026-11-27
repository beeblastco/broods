import { defineAgent, defineDiscordConnection, env } from "broods";

export const discord = defineDiscordConnection({
  allowedChannelIds: ["*"],
  botToken: env("DISCORD_BOT_TOKEN"),
  publicKey: env("DISCORD_PUBLIC_KEY"),
  // With this set the agent answers only when tagged; other messages are kept as context.
  botUserId: env("DISCORD_BOT_USER_ID"),
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
