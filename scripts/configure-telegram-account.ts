/**
 * CI configuration helper for the default Telegram account.
 * Creates or updates account config, then registers the account-scoped webhook.
 */

const DEFAULT_ACCOUNT_USERNAME = "telegram-default";
const DEFAULT_ACCOUNT_DESCRIPTION = "Default Telegram account managed by CI/CD.";
const DEFAULT_REACTION_EMOJI = "👀";

const accountManageUrl = stripTrailingSlash(await outputOrEnv("ACCOUNT_MANAGE_URL", "accountManageUrl"));
const harnessProcessingUrl = stripTrailingSlash(await outputOrEnv("HARNESS_PROCESSING_URL", "harnessProcessingUrl"));
const adminSecret = requireEnv("ADMIN_ACCOUNT_SECRET");
const telegramBotToken = requireEnv("TELEGRAM_BOT_TOKEN");
const telegramWebhookSecret = requireEnv("TELEGRAM_WEBHOOK_SECRET");
const allowedChatIds = parseAllowedChatIds(requireEnv("ALLOWED_CHAT_IDS"));
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

  return bodyText ? JSON.parse(bodyText) : {};
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

async function outputOrEnv(envName: string, outputName: string): Promise<string> {
  const explicit = process.env[envName]?.trim();
  if (explicit) {
    return explicit;
  }

  const outputs = await readSstOutputs();
  const value = outputs[outputName];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing ${envName} and .sst output ${outputName}`);
  }

  return value;
}

async function readSstOutputs(): Promise<Record<string, unknown>> {
  try {
    const raw = await Bun.file(".sst/outputs.json").text();
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch (err) {
    throw new Error(`Unable to read .sst/outputs.json: ${err instanceof Error ? err.message : String(err)}`);
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

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
