/**
 * DynamoDB-backed StorageProvider. Default when STORAGE_PROVIDER is unset
 * or "dynamodb" — the OSS / self-host configuration. Each domain's DDB
 * code lives in its own sibling module so the providers stay readable.
 */

import type { StorageProvider } from "../types.ts";
import { dynamoAccountStore } from "./accounts.ts";
import { dynamoAgentStore } from "./agents.ts";
import { dynamoCronJobStore } from "./cron-jobs.ts";

export const dynamoStorageProvider: StorageProvider = {
  kind: "dynamodb",
  accounts: dynamoAccountStore,
  agents: dynamoAgentStore,
  cronJobs: dynamoCronJobStore,
};

export { dynamoAccountStore, dynamoAgentStore, dynamoCronJobStore };
