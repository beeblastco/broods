import { defineAgent, defineDiscordChannel, env } from "broods";

export const discord = defineDiscordChannel({
  botToken: env.DISCORD_BOT_TOKEN,
  publicKey: env.DISCORD_PUBLIC_KEY,
  allowedGuildIds: process.env.DISCORD_ALLOWED_GUILD_IDS?.split(",").map((value) => value.trim()).filter(Boolean),
});

export const agent = defineAgent({
  name: "discord-channel-agent",
  config: {
    provider: { 
      minimax: { 
        apiKey: env.MINIMAX_API_KEY 
      } 
    },
    model: { 
      provider: "minimax", 
      modelId: "MiniMax-M3" 
    },
    agent: { 
      system: "You are a concise Discord assistant." 
    },
    channels: [discord],
  },
});
