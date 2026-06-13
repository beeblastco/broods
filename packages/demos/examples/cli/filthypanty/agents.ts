import {
  defineAgent,
  defineCronJob,
  defineSandbox,
  defineWorkspace,
  env,
} from "filthy-panty";

export const repo = defineWorkspace("repo", {
  storage: { provider: "s3" },
  harness: { enabled: true },
});

export const runner = defineSandbox("runner", {
  provider: "lambda",
  permissionMode: "ask",
  runtimes: ["bash", "node"],
});

export const support = defineAgent("support", {
  provider: {
    google: { apiKey: env("ACCOUNT_GOOGLE_API_KEY") },
  },
  model: {
    provider: "google",
    modelId: "gemma-4-31b-it",
  },
  agent: {
    system: "You are a helpful demo support agent.",
  },
  sandbox: runner,
  workspaces: [repo],
});

export const dailySummary = defineCronJob("daily-summary", {
  agent: support,
  prompt: "Summarize recent demo workspace activity.",
  conversationKey: "demo:daily-summary",
  scheduleExpression: "rate(1 day)",
  timezone: process.env.CRON_TIMEZONE,
  status: "paused",
});
