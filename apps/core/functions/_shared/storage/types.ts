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
import type {
  SandboxConfigRecord,
  CreateSandboxConfigInput,
  UpdateSandboxConfigInput,
} from "./sandbox-config.ts";
import type {
  WorkspaceConfigRecord,
  CreateWorkspaceConfigInput,
  UpdateWorkspaceConfigInput,
} from "./workspace-config.ts";
import type {
  AccountToolRecord,
  CreateAccountToolInput,
  UpdateAccountToolInput,
} from "./account-tools.ts";

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
  SandboxConfigRecord,
  CreateSandboxConfigInput,
  UpdateSandboxConfigInput,
  WorkspaceConfigRecord,
  CreateWorkspaceConfigInput,
  UpdateWorkspaceConfigInput,
  AccountToolRecord,
  CreateAccountToolInput,
  UpdateAccountToolInput,
};

/** Account CRUD + secret-hash lookup. */
export interface AccountStore {
  getById(accountId: string): Promise<AccountRecord | null>;
  getBySecretHash(secretHash: string): Promise<AccountRecord | null>;
  getByOrgId?(orgId: string): Promise<AccountRecord | null>;
  create(input: CreateAccountInput): Promise<{ account: AccountRecord; secret: string }>;
  update(accountId: string, patch: UpdateAccountInput): Promise<AccountRecord | null>;
  rotateSecret(accountId: string): Promise<{ account: AccountRecord; secret: string } | null>;
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
 * The remaining persistence concerns — conversations/messages, async agent
 * results, async tool results, dedupe, and signup rate limits — are
 * intentionally NOT part of StorageProvider yet. Two reasons:
 *
 * 1. Cherry-coke's Convex schema doesn't match filthy-panty's DDB schema
 *    for these (conversations use a 1:N model in Convex but a flat
 *    composite-key event table in DDB; asyncToolResult needs a GSI +
 *    dispatch-group fan-in that the unified Convex asyncResults table
 *    doesn't model).
 * 2. Dedupe and rate-limits depend on DDB-specific semantics (TTL +
 *    conditional writes) that Convex doesn't expose cleanly.
 *
 * They stay in their current modules under functions/harness-processing/
 * and run against DynamoDB on every stage. When cherry-coke and filthy-panty
 * agree on a shared schema, lift them into this file and add stores.
 */

/** Account-scoped, reusable sandbox config records (encrypted at rest). */
export interface SandboxConfigStore {
  getById(accountId: string, sandboxId: string): Promise<SandboxConfigRecord | null>;
  list(accountId: string): Promise<SandboxConfigRecord[]>;
  create(accountId: string, input: CreateSandboxConfigInput): Promise<SandboxConfigRecord>;
  update(accountId: string, sandboxId: string, patch: UpdateSandboxConfigInput): Promise<SandboxConfigRecord | null>;
  remove(accountId: string, sandboxId: string): Promise<boolean>;
  removeAllForAccount(accountId: string): Promise<number>;
}

/** Account-scoped, reusable workspace config records (plaintext, no secrets). */
export interface WorkspaceConfigStore {
  getById(accountId: string, workspaceId: string): Promise<WorkspaceConfigRecord | null>;
  list(accountId: string): Promise<WorkspaceConfigRecord[]>;
  create(accountId: string, input: CreateWorkspaceConfigInput): Promise<WorkspaceConfigRecord>;
  update(accountId: string, workspaceId: string, patch: UpdateWorkspaceConfigInput): Promise<WorkspaceConfigRecord | null>;
  remove(accountId: string, workspaceId: string): Promise<boolean>;
  removeAllForAccount(accountId: string): Promise<number>;
}

/** Account-scoped uploaded custom tool metadata. */
export interface AccountToolStore {
  getById(accountId: string, toolId: string): Promise<AccountToolRecord | null>;
  list(accountId: string): Promise<AccountToolRecord[]>;
  create(accountId: string, input: CreateAccountToolInput): Promise<AccountToolRecord>;
  update(accountId: string, toolId: string, patch: UpdateAccountToolInput): Promise<AccountToolRecord | null>;
  remove(accountId: string, toolId: string): Promise<boolean>;
  removeAllForAccount(accountId: string): Promise<number>;
}

export interface StorageProvider {
  readonly kind: "dynamodb" | "convex";
  accounts: AccountStore;
  agents: AgentStore;
  cronJobs: CronJobStore;
  sandboxConfigs: SandboxConfigStore;
  workspaceConfigs: WorkspaceConfigStore;
  accountTools: AccountToolStore;
}
