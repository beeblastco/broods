/**
 * Configuration helper for a Pancake channel account.
 * Creates or updates account and agent config, then prints the agent-scoped webhook URL.
 */

import { optionalEnv } from "../functions/_shared/env.ts";
import {
  accountServiceUrl,
  agentServiceUrl,
  createScriptAgentConfig,
  upsertScriptAccount,
} from "./utils.ts";

const pancakePageId = optionalEnv("PANCAKE_PAGE_ID");
const pancakePageAccessToken = optionalEnv("PANCAKE_PAGE_ACCESS_TOKEN");
const pancakeWebhookSecret = optionalEnv("PANCAKE_WEBHOOK_SECRET");
const pancakeSenderId = optionalEnv("PANCAKE_SENDER_ID");
const pancakeHandoffTagId = optionalEnv("PANCAKE_HANDOFF_TAG_ID");

if (!pancakePageId) {
  console.warn("Skipping Pancake account setup: PANCAKE_PAGE_ID is not configured");
  process.exit(0);
}

if (!pancakePageAccessToken) {
  console.warn("Skipping Pancake account setup: PANCAKE_PAGE_ACCESS_TOKEN is not configured");
  process.exit(0);
}

if (!pancakeWebhookSecret) {
  console.warn("Skipping Pancake account setup: PANCAKE_WEBHOOK_SECRET is not configured");
  process.exit(0);
}

const accountServiceUrlValue = accountServiceUrl();
const agentServiceUrlValue = agentServiceUrl();
const adminSecret = process.env.ADMIN_ACCOUNT_SECRET!;
const username = optionalEnv("INTEGRATIONS_ACCOUNT_USERNAME")?.trim() ?? "integrations-default";
const description = optionalEnv("INTEGRATIONS_ACCOUNT_DESCRIPTION")?.trim();
const agentName = optionalEnv("PANCAKE_AGENT_NAME")?.trim() ?? "pancake-default";
const agentDescription = optionalEnv("PANCAKE_AGENT_DESCRIPTION")?.trim();

const { account, agent } = await upsertPancakeAccount();
const webhookUrl = `${agentServiceUrlValue}/webhooks/${encodeURIComponent(account.accountId)}/${encodeURIComponent(agent.agentId)}/pancake?secret=${encodeURIComponent(pancakeWebhookSecret)}`;

console.log(`Configured Pancake account ${account.accountId} and agent ${agent.agentId}`);
console.log(`Register this URL in Pancake webhook settings: ${webhookUrl}`);

async function upsertPancakeAccount() {
  const config = {
    ...createScriptAgentConfig(),
    channels: {
      pancake: {
        pageId: pancakePageId,
        pageAccessToken: pancakePageAccessToken,
        webhookSecret: pancakeWebhookSecret,
        ...(pancakeSenderId ? { senderId: pancakeSenderId } : {}),
        ...(pancakeHandoffTagId
          ? {
            options: {
              ignoreTagIds: [pancakeHandoffTagId],
            },
          }
          : {}),
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
