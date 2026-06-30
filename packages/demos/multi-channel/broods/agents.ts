import { defineAgent, defineGitHubChannel, defineSandbox, defineSkill, defineSlackChannel, defineTelegramChannel, defineWorkspace, env } from "broods";
import fs from "fs";
import path from "path";

const __dirname = new URL(".", import.meta.url).pathname;
const instructions = fs.readFileSync(path.join(__dirname, "instructions.md"), "utf-8").trim();

export const slack = defineSlackChannel({
  id: "slack-support",
  workspaceScope: { level: "channel" },
  botToken: env("SLACK_BOT_TOKEN"),
  signingSecret: env("SLACK_SIGNING_SECRET"),
  allowedChannelIds: ["C0BE2TEBTNW", "C0BDND7TF5M", "C0BDND4UX7H", "C0BE47XETNE"],
  reactionEmoji: process.env.SLACK_REACTION_EMOJI ?? "eyes",
});

export const telegram = defineTelegramChannel({
  id: "telegram-support",
  workspaceScope: { level: "channel" },
  botToken: env("TELEGRAM_BOT_TOKEN"),
  webhookSecret: env("TELEGRAM_WEBHOOK_SECRET"),
  allowedChatIds: [8096152290, 7495331456],
  reactionEmoji: "\u{1F440}", 
});

export const github = defineGitHubChannel({
  id: "github-support",
  workspaceScope: { alias: "support", level: "conversation" },
  appId: env("GITHUB_APP_ID"),
  privateKey: env("GITHUB_PRIVATE_KEY"),
  webhookSecret: env("GITHUB_WEBHOOK_SECRET"),
  allowedRepos: ["beeblastco/broods"],
});

export const hubSpotSkill = defineSkill({
  name: "hubspot",
  config: {
    path: "./skills/hubspot",
  },   
})

export const sandbox = defineSandbox({
  name: "lambda-sandbox",
  config: {
    provider: "lambda",
    network: { mode: "allow-all" },
    permissionMode: "bypass",
    persistent: true,
    lifecycle: {
      idleTimeoutSeconds: 900,
      maxLifetimeSeconds: 28800,
    },
    envVars: {
      HUBSPOT_API_TOKEN: env("HUBSPOT_API_TOKEN"),
      HUBSPOT_BASE_URL: "https://api.hubapi.com"
    }
  },
})

export const workspace = defineWorkspace({
  name: "workspace",
  config: {
    storage: { provider: "s3" },
    isolation: true,
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
    channels: [slack, telegram, github],
    sandbox: sandbox,
    workspaces: [workspace],
    subagent: {
      enabled: true,
    },
    publicAccess: true,
    skills: {
      enabled: true,
      allowed: [hubSpotSkill],
    }
  },
});
