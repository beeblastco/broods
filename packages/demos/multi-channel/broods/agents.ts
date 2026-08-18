import {
  defineAgent,
  defineGitHubChannel,
  defineGitHubConnection,
  defineSandbox,
  defineSkill,
  defineSlackChannel,
  defineSlackConnection,
  defineTelegramChannel,
  defineTelegramConnection,
  defineWorkspace,
  env,
} from "broods";
import fs from "fs";
import path from "path";

const __dirname = new URL(".", import.meta.url).pathname;
const instructions = fs
  .readFileSync(path.join(__dirname, "instructions.md"), "utf-8")
  .trim();
const setupGitDevEnvironment = fs
  .readFileSync(path.join(__dirname, "hooks/setup-github-dev.sh"), "utf-8")
  .trim();
const githubGitUserName = process.env.GITHUB_BOT_USERNAME;
const githubGitUserEmail = process.env.GITHUB_GIT_USER_EMAIL;
const optionalSandboxGithubEnv = {
  ...(process.env.GITHUB_INSTALLATION_ID
    ? { GITHUB_INSTALLATION_ID: env("GITHUB_INSTALLATION_ID") }
    : {}),
};

export const slack = defineSlackConnection({
  partition: { by: "shared" },
  botToken: env("SLACK_BOT_TOKEN"),
  signingSecret: env("SLACK_SIGNING_SECRET"),
  reactionEmoji: process.env.SLACK_REACTION_EMOJI ?? "eyes",
});

// Reach is deny-by-default: these two rooms are the ones this agent answers in.
export const slackGeneral = defineSlackChannel({
  name: "multi-channel-general",
  connection: slack,
  channelId: "C0BEDDS52GK",
});

export const slackOps = defineSlackChannel({
  name: "multi-channel-ops",
  connection: slack,
  channelId: "C0BEQ9XRE4A",
});

export const telegram = defineTelegramConnection({
  partition: { by: "shared" },
  botToken: env("TELEGRAM_BOT_TOKEN"),
  webhookSecret: env("TELEGRAM_WEBHOOK_SECRET"),
  reactionEmoji: "\u{1F440}",
});

export const telegramPrimary = defineTelegramChannel({
  name: "multi-channel-telegram-primary",
  connection: telegram,
  chatId: "8096152290",
});

export const telegramSecondary = defineTelegramChannel({
  name: "multi-channel-telegram-secondary",
  connection: telegram,
  chatId: "7495331456",
});

// A GitHub App's reach is already the repositories it was installed on, so the
// wildcard defers to that rather than repeating the list here.
export const github = defineGitHubConnection({
  allowedChannelIds: ["*"],
  partition: { by: "shared" },
  appId: env("GITHUB_APP_ID"),
  privateKey: env("GITHUB_PRIVATE_KEY"),
  webhookSecret: env("GITHUB_WEBHOOK_SECRET"),
  userName: env("GITHUB_BOT_USERNAME"),
  triggerOnIssueOpen: false,
  triggerOnPROpen: false,
});

export const hubSpotSkill = defineSkill({
  name: "hubspot",
  path: "./skills/hubspot",
});

export const sandbox = defineSandbox({
  name: "lambda-sandbox",
  provider: "lambda",
  network: { mode: "allow-all" },
  permissionMode: "bypass",
  persistent: true,
  lifecycle: {
    idleTimeoutSeconds: 900,
    maxLifetimeSeconds: 3600,
  },
  onCreate: [setupGitDevEnvironment],
  onResume: [setupGitDevEnvironment],
  envVars: {
    HUBSPOT_API_TOKEN: env("HUBSPOT_API_TOKEN"),
    HUBSPOT_BASE_URL: "https://api.hubapi.com",
    GITHUB_APP_ID: env("GITHUB_APP_ID"),
    GITHUB_PRIVATE_KEY: env("GITHUB_PRIVATE_KEY"),
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_GIT_USER_NAME: githubGitUserName,
    GITHUB_GIT_USER_EMAIL: githubGitUserEmail,
    GIT_TERMINAL_PROMPT: "0",
    ...optionalSandboxGithubEnv,
  },
});

export const workspace = defineWorkspace({
  name: "workspace",
  storage: { provider: "s3" },
  partitioned: true,
});

export const agent = defineAgent({
  name: "slack-channel-agent",
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
        reasoningConfig: { type: "enabled", budgetTokens: 16000 },
      },
    },
  },
  agent: {
    system: instructions,
    maxTurn: 100,
  },
  connections: [slack, telegram, github],
  sandbox: sandbox,
  workspaces: [workspace],
  subagent: {
    enabled: true,
  },
  publicAccess: true,
  skills: {
    enabled: true,
    allowed: [hubSpotSkill],
  },
});
