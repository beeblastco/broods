/**
 * Configuration helper for a Zalo channel account.
 * Creates or updates account and agent config, then registers the agent-scoped webhook.
 */

import { optionalEnv } from "../functions/_shared/env.ts";
import { accountServiceUrl, agentServiceUrl, createScriptAgentConfig, upsertScriptAccount } from "./utils.ts";

const zaloBotToken = optionalEnv("ZALO_BOT_TOKEN");
const zaloWebhookSecret = optionalEnv("ZALO_WEBHOOK_SECRET");
const allowedUserIds = optionalEnv("ZALO_ALLOWED_USER_IDS");

if (!zaloBotToken) {
  console.warn("Skipping Zalo account setup: ZALO_BOT_TOKEN is not configured");
  process.exit(0);
}

if (!zaloWebhookSecret) {
  console.warn("Skipping Zalo account setup: ZALO_WEBHOOK_SECRET is not configured");
  process.exit(0);
}

if (!allowedUserIds) {
  console.warn("Skipping Zalo account setup: ZALO_ALLOWED_USER_IDS is not configured");
  process.exit(0);
}

const accountServiceUrlValue = accountServiceUrl();
const agentServiceUrlValue = agentServiceUrl();
const adminSecret = process.env.ADMIN_ACCOUNT_SECRET!;
const parsedUserIds = parseAllowedUserIds(allowedUserIds);
const username = optionalEnv("INTEGRATIONS_ACCOUNT_USERNAME")?.trim() ?? "integrations-default";
const description = optionalEnv("INTEGRATIONS_ACCOUNT_DESCRIPTION")?.trim();
const agentName = optionalEnv("ZALO_AGENT_NAME")?.trim() ?? "zalo-default";
const agentDescription = optionalEnv("ZALO_AGENT_DESCRIPTION")?.trim();

const { account, agent } = await upsertZaloAccount();
const webhookUrl = `${agentServiceUrlValue}/webhooks/${encodeURIComponent(account.accountId)}/${encodeURIComponent(agent.agentId)}/zalo`;
await setZaloWebhook(webhookUrl);

console.log(`Configured Zalo account ${account.accountId}, agent ${agent.agentId}, and webhook ${webhookUrl}`);

async function upsertZaloAccount() {
  const config = {
    ...createScriptAgentConfig(),
    channels: {
      zalo: {
        botToken: zaloBotToken,
        webhookSecret: zaloWebhookSecret,
        allowedUserIds: parsedUserIds,
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

async function setZaloWebhook(url: string): Promise<void> {
  const response = await fetch(`https://bot-api.zaloplatforms.com/bot${zaloBotToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      secret_token: zaloWebhookSecret,
    }),
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Zalo setWebhook failed: ${response.status} ${bodyText}`);
  }

  const parsed = parseJsonBody(bodyText);
  if (parsed?.ok === false) {
    throw new Error(`Zalo setWebhook failed: ${parsed.description ?? parsed.error_code ?? "unknown_error"}`);
  }
}

function parseAllowedUserIds(raw: string): string[] {
  const ids = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (ids.length === 0) {
    throw new Error("ZALO_ALLOWED_USER_IDS must contain at least one Zalo user id");
  }

  return ids;
}

function parseJsonBody(text: string): { ok?: boolean; error_code?: number; description?: string } | null {
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object"
      ? parsed as { ok?: boolean; error_code?: number; description?: string }
      : null;
  } catch {
    return null;
  }
}
