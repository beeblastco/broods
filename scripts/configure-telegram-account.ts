/**
 * CI configuration helper for the default Telegram account.
 * Creates or updates account config, then registers the account-scoped webhook.
 */

import {
  accountManageUrl,
  createScriptAccountRuntimeConfig,
  harnessProcessingUrl,
  requireScriptEnv,
  upsertScriptAccount,
} from "./utils.ts";

const accountManageUrlValue = accountManageUrl();
const harnessProcessingUrlValue = harnessProcessingUrl();
const adminSecret = requireScriptEnv("ADMIN_ACCOUNT_SECRET");
const telegramBotToken = requireScriptEnv("TELEGRAM_BOT_TOKEN");
const telegramWebhookSecret = requireScriptEnv("TELEGRAM_WEBHOOK_SECRET");
const allowedChatIds = parseAllowedChatIds(requireScriptEnv("ALLOWED_CHAT_IDS"));
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
        allowedChatIds,
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
