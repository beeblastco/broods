/**
 * Configuration helper for a Pancake channel account.
 * Creates or updates account and agent config, then prints the agent-scoped webhook URL.
 */

import { optionalEnv } from "../functions/_shared/env.ts";
import { accountServiceUrl, agentServiceUrl, createScriptAgentConfig, upsertScriptAccount } from "./utils.ts";

const pancakePageId = optionalEnv("PANCAKE_PAGE_ID");
const pancakePageAccessToken = optionalEnv("PANCAKE_PAGE_ACCESS_TOKEN");
const pancakeSenderId = optionalEnv("PANCAKE_SENDER_ID");
const pancakeSupabaseUrl = optionalEnv("PANCAKE_SUPABASE_URL");
const pancakeSupabaseServiceRoleKey = optionalEnv("PANCAKE_SUPABASE_SERVICE_ROLE_KEY");

if (!pancakePageId) {
  console.warn("Skipping Pancake account setup: PANCAKE_PAGE_ID is not configured");
  process.exit(0);
}

if (!pancakePageAccessToken) {
  console.warn("Skipping Pancake account setup: PANCAKE_PAGE_ACCESS_TOKEN is not configured");
  process.exit(0);
}

const accountServiceUrlValue = accountServiceUrl();
const agentServiceUrlValue = agentServiceUrl();
const adminSecret = process.env.ADMIN_ACCOUNT_SECRET!;
const username = optionalEnv("INTEGRATIONS_ACCOUNT_USERNAME")?.trim() ?? "integrations-default";
const description = optionalEnv("INTEGRATIONS_ACCOUNT_DESCRIPTION")?.trim();
const agentName = optionalEnv("PANCAKE_AGENT_NAME")?.trim() ?? "pancake-default";
const agentDescription = optionalEnv("PANCAKE_AGENT_DESCRIPTION")?.trim();

if (Boolean(pancakeSupabaseUrl) !== Boolean(pancakeSupabaseServiceRoleKey)) {
  throw new Error("Set both PANCAKE_SUPABASE_URL and PANCAKE_SUPABASE_SERVICE_ROLE_KEY, or neither");
}

const { account, agent } = await upsertPancakeAccount();
const webhookUrl = `${agentServiceUrlValue}/webhooks/${encodeURIComponent(account.accountId)}/${encodeURIComponent(agent.agentId)}/pancake`;

console.log(`Configured Pancake account ${account.accountId} and agent ${agent.agentId}`);
console.log(`Register this URL in Pancake webhook settings: ${webhookUrl}`);

async function upsertPancakeAccount() {
  const config = {
    ...createScriptAgentConfig(),
    channels: {
      pancake: {
        pageId: pancakePageId,
        pageAccessToken: pancakePageAccessToken,
        ...(pancakeSenderId ? { senderId: pancakeSenderId } : {}),
        ...(pancakeSupabaseUrl && pancakeSupabaseServiceRoleKey
          ? {
            options: {
              components: {
                conversationState: {
                  provider: "supabase",
                  url: pancakeSupabaseUrl,
                  serviceRoleKey: pancakeSupabaseServiceRoleKey,
                },
              },
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
