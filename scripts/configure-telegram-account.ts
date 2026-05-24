/**
 * CI configuration helper for the default Telegram account.
 * Creates or updates account and agent config, then registers the agent-scoped webhook.
 * Skips gracefully if TELEGRAM_BOT_TOKEN is not provided.
 */

import { optionalEnv } from "../functions/_shared/env.ts";
import { accountServiceUrl, agentServiceUrl, createScriptAgentConfig, upsertScriptAccount } from "./utils.ts";

const telegramBotToken = optionalEnv("TELEGRAM_BOT_TOKEN");
const telegramWebhookSecret = optionalEnv("TELEGRAM_WEBHOOK_SECRET");
const allowedChatIds = optionalEnv("ALLOWED_CHAT_IDS");

if (!telegramBotToken) {
  console.warn("Skipping Telegram account setup: TELEGRAM_BOT_TOKEN is not configured");
  process.exit(0);
}

if (!telegramWebhookSecret) {
  console.warn("Skipping Telegram account setup: TELEGRAM_WEBHOOK_SECRET is not configured");
  process.exit(0);
}

if (!allowedChatIds) {
  console.warn("Skipping Telegram account setup: ALLOWED_CHAT_IDS is not configured");
  process.exit(0);
}

const accountServiceUrlValue = accountServiceUrl();
const agentServiceUrlValue = agentServiceUrl();
const adminSecret = process.env.ADMIN_ACCOUNT_SECRET!;
const parsedChatIds = parseAllowedChatIds(allowedChatIds);
const username = optionalEnv("INTEGRATIONS_ACCOUNT_USERNAME")?.trim() ?? "integrations-default";
const description = optionalEnv("INTEGRATIONS_ACCOUNT_DESCRIPTION")?.trim();
const agentName = optionalEnv("TELEGRAM_AGENT_NAME")?.trim() ?? "telegram-default";
const agentDescription = optionalEnv("TELEGRAM_AGENT_DESCRIPTION")?.trim();

const { account, agent } = await upsertTelegramAccount();
const webhookUrl = `${agentServiceUrlValue}/webhooks/${encodeURIComponent(account.accountId)}/${encodeURIComponent(agent.agentId)}/telegram`;
await setTelegramWebhook(webhookUrl);

console.log(`Configured Telegram account ${account.accountId}, agent ${agent.agentId}, and webhook ${webhookUrl}`);

async function upsertTelegramAccount() {
  const config = {
    ...createScriptAgentConfig(),
    channels: {
      telegram: {
        botToken: telegramBotToken,
        webhookSecret: telegramWebhookSecret,
        allowedChatIds: parsedChatIds,
        reactionEmoji: "👀",
      },
    },
  };

  return upsertScriptAccount({
    accountServiceUrl: accountServiceUrlValue,
    adminSecret,
    username,
    description,
    agentName,
    agentDescription,
    config,
  });
}

async function setTelegramWebhook(url: string): Promise<void> {
  const params = new URLSearchParams({
    url,
    secret_token: telegramWebhookSecret!,
    allowed_updates: JSON.stringify(["message", "edited_message"]),
  });
  const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/setWebhook`, {
    method: "POST",
    body: params,
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Telegram setWebhook failed: ${response.status} ${bodyText}`);
  }
}

function parseAllowedChatIds(raw: string): number[] {
  const ids = raw
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isSafeInteger(entry));

  if (ids.length === 0) {
    throw new Error("ALLOWED_CHAT_IDS must contain at least one numeric Telegram chat id");
  }

  return ids;
}
