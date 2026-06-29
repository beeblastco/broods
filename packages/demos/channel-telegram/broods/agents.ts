import { defineAgent, defineSandbox, defineWorkspace, defineTelegramChannel, env } from "broods";
import fs from "fs";
import path from "path";

const __dirname = new URL(".", import.meta.url).pathname;
const mainInstructions = fs.readFileSync(path.join(__dirname, "main_instruction.md"), "utf-8").trim();
const researchInstructions = fs.readFileSync(path.join(__dirname, "research_instruction.md"), "utf-8").trim();

export const telegram = defineTelegramChannel({
  botToken: env.TELEGRAM_BOT_TOKEN,
  webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
  allowedChatIds: [8096152290, 7495331456],
  reactionEmoji: "\u{1F440}",
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

export const researchSpecialist = defineAgent({
  name: "research-specialist",
  config: {
    provider: {
      google: { apiKey: env.GOOGLE_API_KEY },
    },
    model: {
      provider: "google",
      modelId: "gemma-4-31b-it",
    },
    agent: {
      system: researchInstructions,
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
    workspaces: [
      { workspace: personalWorkspace, sandbox: lambdaSandbox }
    ],
  },
})

export const agent = defineAgent({
  name: "telegram-channel-agent",
  config: {
    provider: {
      google: { apiKey: env.GOOGLE_API_KEY },
    },
    model: {
      provider: "google",
      modelId: "gemma-4-31b-it",
    },
    agent: {
      system: mainInstructions,
    },
    subagent: {
      enabled: true,
      allowed: [researchSpecialist],
    },
    channels: [telegram],
    workspaces: [
      { workspace: personalWorkspace, sandbox: lambdaSandbox }
    ],
  },
});
