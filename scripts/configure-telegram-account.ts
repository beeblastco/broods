/**
 * CI configuration helper for the default Telegram account.
 * Creates or updates account config, then registers the account-scoped webhook.
 */

import {
  isRecord,
  outputOrEnv,
  parseJson,
  requireScriptEnv,
  stripTrailingSlash,
} from "./utils.ts";

const DEFAULT_ACCOUNT_USERNAME = "telegram-default";
const DEFAULT_ACCOUNT_DESCRIPTION = "Default Telegram account managed by CI/CD.";
const DEFAULT_REACTION_EMOJI = "👀";

const accountManageUrl = stripTrailingSlash(outputOrEnv("ACCOUNT_MANAGE_URL", "accountManageUrl"));
const harnessProcessingUrl = stripTrailingSlash(outputOrEnv("HARNESS_PROCESSING_URL", "harnessProcessingUrl"));
const adminSecret = requireScriptEnv("ADMIN_ACCOUNT_SECRET");
const telegramBotToken = requireScriptEnv("TELEGRAM_BOT_TOKEN");
const telegramWebhookSecret = requireScriptEnv("TELEGRAM_WEBHOOK_SECRET");
const allowedChatIds = parseAllowedChatIds(requireScriptEnv("ALLOWED_CHAT_IDS"));
const username = process.env.TELEGRAM_ACCOUNT_USERNAME?.trim() || DEFAULT_ACCOUNT_USERNAME;
const description = process.env.TELEGRAM_ACCOUNT_DESCRIPTION?.trim() || DEFAULT_ACCOUNT_DESCRIPTION;

const account = await upsertTelegramAccount();
const webhookUrl = `${harnessProcessingUrl}/webhooks/${encodeURIComponent(account.accountId)}/telegram`;
await setTelegramWebhook(webhookUrl);

console.log(`Configured Telegram account ${account.accountId} and webhook ${webhookUrl}`);

interface PublicAccount {
  accountId: string;
  username: string;
}

async function upsertTelegramAccount(): Promise<PublicAccount> {
  const existing = await findExistingAccount();
  const config = {
    channels: {
      telegram: {
        botToken: telegramBotToken,
        webhookSecret: telegramWebhookSecret,
        allowedChatIds,
        reactionEmoji: DEFAULT_REACTION_EMOJI,
      },
    },
  };

  if (existing) {
    const updated = await accountApi("PATCH", `/accounts/${encodeURIComponent(existing.accountId)}`, {
      username,
      description,
      config,
    });
    return parseAccountResponse(updated);
  }

  const created = await publicAccountApi("POST", "/accounts", {
    username,
    description,
    config,
  });
  return parseAccountResponse(created);
}

async function findExistingAccount(): Promise<PublicAccount | null> {
  const response = await accountApi("GET", "/accounts");
  if (!isRecord(response) || !Array.isArray(response.accounts)) {
    throw new Error("Account list response must include accounts array");
  }

  return response.accounts.find((entry): entry is PublicAccount =>
    isPublicAccount(entry) && entry.username === username,
  ) ?? null;
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

async function accountApi(method: string, path: string, body?: unknown): Promise<unknown> {
  return requestJson(`${accountManageUrl}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${adminSecret}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function publicAccountApi(method: string, path: string, body: unknown): Promise<unknown> {
  return requestJson(`${accountManageUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function requestJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${url} failed: ${response.status} ${bodyText}`);
  }

  return bodyText ? parseJson(bodyText) : {};
}

function parseAccountResponse(value: unknown): PublicAccount {
  if (!isRecord(value) || !isPublicAccount(value.account)) {
    throw new Error("Account response must include account.accountId and account.username");
  }

  return value.account;
}

function isPublicAccount(value: unknown): value is PublicAccount {
  return isRecord(value) &&
    typeof value.accountId === "string" &&
    typeof value.username === "string";
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
