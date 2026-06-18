import { defineAgent, defineSandbox, defineWorkspace, defineTelegramChannel, env } from "filthy-panty";

export const telegram = defineTelegramChannel({
  botToken: env.TELEGRAM_BOT_TOKEN,
  webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
  allowedChatIds: [Number(process.env.TELEGRAM_ALLOWED_CHAT_ID ?? "0")],
  reactionEmoji: "\u{1F440}",
  streaming: { mode: "progress" },
});

export const lambdaSandbox = defineSandbox({
  name: "stateless-sandbox",
  config: {
    provider: "lambda",
    network: { mode: "allow-all" },
    permissionMode: "bypass",
    timeout: 60,
  },
})

export const personalWorkspace = defineWorkspace({
  name: "personal",
  description: "Workspace for personal notes",
  config: {
    storage: { provider: "s3" },
    harness: { enabled: true },
  },
})

export const agent = defineAgent({
  name: "telegram-channel-agent",
  config: {
    provider: { 
      minimax: { 
        apiKey: env.MINIMAX_API_KEY,
      } 
    },
    model: {
      provider: "minimax", 
      modelId: "MiniMax-M3",
    },
    agent: {
      system: "You are a helpful assistant.",
    },
    tools: {
      tavilySearch: {
        enabled: true,
        apiKey: env.TAVILY_API_KEY,
        searchDepth: "advanced",
        includeAnswer: true,
        maxResults: 5,
        topic: "news",
      },
    },
    channels: [telegram],
    workspaces: [
      { workspace: personalWorkspace, sandbox: lambdaSandbox }
    ],
  },
});
