/**
 * Domain-shaped StorageProvider interface and record types.
 * The provider abstracts persistence so the same Lambda binary can talk to
 * DynamoDB (OSS / self-host default) or Convex (SaaS deployment).
 *
 * Method names mirror the Convex submodule (getById, getBySecretHash, create,
 * update, remove, list) rather than DDB primitives. Records are re-exported
 * from the existing _shared/ modules — do not duplicate.
 */

import type {
  AccountRecord,
  AccountStatus,
  CreateAccountInput,
  UpdateAccountInput,
} from "./accounts.ts";
import type {
  AgentRecord,
  AgentStatus,
  CreateAgentInput,
  UpdateAgentInput,
} from "./agents.ts";
import type {
  CronJobRecord,
  CronJobStatus,
  CreateCronJobInput,
  UpdateCronJobInput,
} from "./cron-jobs.ts";

export type {
  AccountRecord,
  AccountStatus,
  CreateAccountInput,
  UpdateAccountInput,
  AgentRecord,
  AgentStatus,
  CreateAgentInput,
  UpdateAgentInput,
  CronJobRecord,
  CronJobStatus,
  CreateCronJobInput,
  UpdateCronJobInput,
};

/** Account CRUD + secret-hash lookup. */
export interface AccountStore {
  getById(accountId: string): Promise<AccountRecord | null>;
  getBySecretHash(secretHash: string): Promise<AccountRecord | null>;
  getByOrgId?(orgId: string): Promise<AccountRecord | null>;
  create(input: CreateAccountInput): Promise<{ account: AccountRecord; accountSecret: string }>;
  update(accountId: string, patch: UpdateAccountInput): Promise<AccountRecord | null>;
  rotateSecret(accountId: string): Promise<{ account: AccountRecord; accountSecret: string } | null>;
  remove(accountId: string): Promise<boolean>;
  list(): Promise<AccountRecord[]>;
}

/** Account-scoped agent records with encrypted config. */
export interface AgentStore {
  getById(accountId: string, agentId: string): Promise<AgentRecord | null>;
  list(accountId: string): Promise<AgentRecord[]>;
  create(accountId: string, input: CreateAgentInput): Promise<AgentRecord>;
  update(accountId: string, agentId: string, patch: UpdateAgentInput): Promise<AgentRecord | null>;
  remove(accountId: string, agentId: string): Promise<boolean>;
  removeAllForAccount(accountId: string): Promise<number>;
}

/** Account-scoped cron job schedules. */
export interface CronJobStore {
  getById(accountId: string, cronJobId: string): Promise<CronJobRecord | null>;
  list(accountId: string): Promise<CronJobRecord[]>;
  create(
    accountId: string,
    input: CreateCronJobInput,
    options: { schedulerGroupName: string },
  ): Promise<CronJobRecord>;
  update(accountId: string, cronJobId: string, patch: UpdateCronJobInput): Promise<CronJobRecord | null>;
  remove(accountId: string, cronJobId: string): Promise<boolean>;
  markStarted(accountId: string, cronJobId: string): Promise<void>;
  markCompleted(accountId: string, cronJobId: string): Promise<void>;
  markFailed(accountId: string, cronJobId: string, error: string): Promise<void>;
}

/**
 * Conversation, message, async result, and skill stores are declared here for
 * forward compatibility with the SaaS Convex provider. The DynamoDB provider
 * does not implement these yet — those domains still live inside
 * functions/harness-processing/session.ts and S3-backed skills.ts. A future
 * commit will lift them into the storage layer; until then, the dynamo
 * provider exposes these as `undefined`.
 */
export interface ConversationStore {
  getById(conversationId: string): Promise<unknown | null>;
  list(accountId: string): Promise<unknown[]>;
  listByAgent(accountId: string, agentId: string): Promise<unknown[]>;
  create(input: Record<string, unknown>): Promise<{ conversationId: string }>;
  update(conversationId: string, patch: Record<string, unknown>): Promise<void>;
  remove(conversationId: string): Promise<boolean>;
}

export interface MessageStore {
  list(conversationId: string): Promise<unknown[]>;
  create(input: Record<string, unknown>): Promise<{ messageId: string }>;
}

export interface AsyncResultStore {
  getByEventId(eventId: string): Promise<unknown | null>;
  list(accountId: string): Promise<unknown[]>;
  create(input: Record<string, unknown>): Promise<{ eventId: string }>;
  update(eventId: string, patch: Record<string, unknown>): Promise<void>;
}

export interface SkillStore {
  getById(accountId: string, skillName: string): Promise<unknown | null>;
  list(accountId: string): Promise<unknown[]>;
  create(input: Record<string, unknown>): Promise<{ skillName: string }>;
  update(accountId: string, skillName: string, patch: Record<string, unknown>): Promise<void>;
  remove(accountId: string, skillName: string): Promise<boolean>;
}

export interface StorageProvider {
  readonly kind: "dynamodb" | "convex";
  accounts: AccountStore;
  agents: AgentStore;
  cronJobs: CronJobStore;
  conversations?: ConversationStore;
  messages?: MessageStore;
  asyncResults?: AsyncResultStore;
  skills?: SkillStore;
}
