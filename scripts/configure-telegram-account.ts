/**
 * CI configuration helper for the default Telegram account.
 * Creates or updates account config, then registers the account-scoped webhook.
 * Skips gracefully if TELEGRAM_BOT_TOKEN is not provided.
 */

import {
  accountManageUrl,
  createScriptAccountRuntimeConfig,
  harnessProcessingUrl,
  optionalScriptEnv,
  requireScriptEnv,
  upsertScriptAccount,
} from "./utils.ts";

const telegramBotToken = optionalScriptEnv("TELEGRAM_BOT_TOKEN");
const telegramWebhookSecret = optionalScriptEnv("TELEGRAM_WEBHOOK_SECRET");
const allowedChatIds = optionalScriptEnv("ALLOWED_CHAT_IDS");

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

const accountManageUrlValue = accountManageUrl();
const harnessProcessingUrlValue = harnessProcessingUrl();
const adminSecret = requireScriptEnv("ADMIN_ACCOUNT_SECRET");
const parsedChatIds = parseAllowedChatIds(allowedChatIds);
const username = process.env.TELEGRAM_ACCOUNT_USERNAME?.trim();
const description = process.env.TELEGRAM_ACCOUNT_DESCRIPTION?.trim();

const account = await upsertTelegramAccount();
const webhookUrl = `${harnessProcessingUrlValue}/webhooks/${encodeURIComponent(account.accountId)}/telegram`;
await setTelegramWebhook(webhookUrl);

console.log(`Configured Telegram account ${account.accountId} and webhook ${webhookUrl}`);

async function upsertTelegramAccount() {
  const config = {
    ...createScriptAccountRuntimeConfig(),
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
    accountManageUrl: accountManageUrlValue,
    adminSecret,
    username,
    description,
    config,
  });
}

async function setTelegramWebhook(url: string): Promise<void> {
  const params = new URLSearchParams({
    url,
    secret_token: telegramWebhookSecret,
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
