import { defineAgent, defineSlackChannel, defineTelegramChannel, defineSandbox, defineWorkspace, env } from "broods";
import fs from "fs";
import path from "path";

const __dirname = new URL(".", import.meta.url).pathname;
const instructions = fs.readFileSync(path.join(__dirname, "instructions.md"), "utf-8").trim();

export const slack = defineSlackChannel({
  botToken: env("SLACK_BOT_TOKEN"),
  signingSecret: env("SLACK_SIGNING_SECRET"),
  allowedChannelIds: ["C0A698FER9D", "C0BDZ4DK3PF", "C0BDW6155K5"],
  reactionEmoji: process.env.SLACK_REACTION_EMOJI ?? "eyes",
});

export const telegram = defineTelegramChannel({
  botToken: env("TELEGRAM_BOT_TOKEN"),
  webhookSecret: env("TELEGRAM_WEBHOOK_SECRET"),
  allowedChatIds: [8096152290, 7495331456],
  reactionEmoji: "\u{1F440}",
});

export const sandbox = defineSandbox({
  name: "lambda-sandbox",
  config: {
    provider: "lambda",
    network: { mode: "allow-all" },
    permissionMode: "bypass",
  },
})

export const workspace = defineWorkspace({
  name: "workspace",
  config: {
    storage: { provider: "s3" },
    harness: { enabled: true },
  }
})

export const agent = defineAgent({
  name: "slack-channel-agent",
  config: {
    provider: {
      bedrock: {
        region: "us-east-1",
        apiKey: env("BEDROCK_API_KEY"),
      },
    },
    model: {
      provider: "bedrock",
      modelId: "minimax.minimax-m2.5",
      providerOptions: {
        bedrock: {
          reasoningConfig: { type: 'enabled', budgetTokens: 16000 },
        }
      },
    },
    agent: {
      system: instructions,
      maxTurn: 100,
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
      tavilyExtract: {
        enabled: true,
        apiKey: env.TAVILY_API_KEY,
      }
    },
    channels: [slack, telegram],
    sandbox: sandbox,
    workspaces: [workspace],
    subagent: {
      enabled: true,
    },
    publicAccess: true,
  },
});
