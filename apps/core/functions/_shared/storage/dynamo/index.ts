/**
 * DynamoDB-backed StorageProvider. Default when STORAGE_PROVIDER is unset
 * or "dynamodb" — the OSS / self-host configuration. Each domain's DDB
 * code lives in its own sibling module so the providers stay readable.
 */

import type { StorageProvider } from "../types.ts";
import { dynamoAccountToolStore } from "./account-tools.ts";
import { dynamoAccountStore } from "./accounts.ts";
import { dynamoAgentStore } from "./agents.ts";
import { dynamoCronStore } from "./cron.ts";
import { dynamoSandboxConfigStore } from "./sandbox-configs.ts";
import { dynamoUsageStore } from "./usage.ts";
import { dynamoWorkspaceConfigStore } from "./workspace-configs.ts";

export const dynamoStorageProvider: StorageProvider = {
  kind: "dynamodb",
  accounts: dynamoAccountStore,
  agents: dynamoAgentStore,
  agentDeployments: {
    async getByApiKeyHash() {
      return null;
    },
    async getByAgentId() {
      return null;
    },
  },
  crons: dynamoCronStore,
  sandboxConfigs: dynamoSandboxConfigStore,
  workspaceConfigs: dynamoWorkspaceConfigStore,
  accountTools: dynamoAccountToolStore,
  usage: dynamoUsageStore,
};

export {
  dynamoAccountToolStore,
  dynamoAccountStore,
  dynamoAgentStore,
  dynamoCronStore,
  dynamoSandboxConfigStore,
  dynamoUsageStore,
  dynamoWorkspaceConfigStore,
};
