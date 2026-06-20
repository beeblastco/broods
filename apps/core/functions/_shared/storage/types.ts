/**
 * Domain-shaped StorageProvider interface and record types.
 * The provider abstracts persistence so the same Lambda binary can talk to
 * DynamoDB (OSS / self-host default) or Convex (SaaS deployment).
 *
 * Method names mirror the Convex submodule (getById, getBySecretHash, create,
 * update, remove, list) rather than DDB primitives. Records are re-exported
 * from the existing _shared/ modules — do not duplicate.
 *
 * Usage metering: see UsageTaskInput / UsageStore below. The active provider
 * writes one row per finished task. Convex uses full endpoint/project/env
 * scope; DynamoDB uses coarser account+agent scope.
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
  CronRecord,
  CronRunRecord,
  CronStatus,
  CreateCronInput,
  UpdateCronInput,
} from "./cron.ts";
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
  CronRecord,
  CronRunRecord,
  CronStatus,
  CreateCronInput,
  UpdateCronInput,
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

/**
 * Raw counts for one finished agent task. No dollar amounts — pricing is
 * computed at render time from a shared hardcoded table (plan §6d, §10a).
 *
 * endpointId / project / environment are optional: the Convex adapter uses
 * them for full per-env scope; the DynamoDB adapter ignores them (coarser
 * account+agent scope per plan §8d decision).
 */
export interface UsageTaskInput {
  accountId: string;
  /** Convex endpoint identifier — undefined in DynamoDB mode. */
  endpointId?: string;
  /** Deployment project slug — undefined in DynamoDB mode. */
  project?: string;
  /** Deployment environment slug — undefined in DynamoDB mode. */
  environment?: string;
  agentId: string;
  conversationKey: string;
  /** Equals session.eventId — unique per finished task. */
  taskId: string;
  modelProvider: string;
  modelId: string;
  /** Unix epoch ms when the task finished. */
  finishedAt: number;
  /** Wall-clock duration of the full task invocation in ms. */
  durationMs: number;
  status: "completed" | "failed";
  /** Prompt (non-cached) input tokens. */
  inputTokens: number;
  /** Completion tokens generated. */
  outputTokens: number;
  /** Thinking / reasoning tokens (Anthropic extended thinking). */
  reasoningTokens: number;
  /** Cache-read input tokens (served from an existing cache entry). */
  cachedInputTokens: number;
  /** Cache-write tokens (tokens that created a new cache entry). */
  cacheWriteTokens: number;
  /** Total tokens across all dimensions (provider definition). */
  totalTokens: number;
  /** Harness runtime backend (currently always "lambda"). */
  runtimeKind: string;
  /** Harness runtime wall-clock ms (durationMs × memoryMb proxy). */
  runtimeWallMs: number;
  /** Harness runtime memory size in MB (AWS_LAMBDA_FUNCTION_MEMORY_SIZE). */
  runtimeMemoryMb: number;
  /** CPU per sandbox context; cgroup cpu.stat delta, recorded for kubernetes only. */
  sandboxUsage: SandboxUsageEntry[];
  /** Number of model steps executed in this task. */
  stepCount: number;
  /** Number of tool calls made across all steps. */
  toolCallCount: number;
}

/** One sandbox's CPU within a task: the agent's own sandbox or a per-tool sandbox. */
export interface SandboxUsageEntry {
  /** Sandbox provider type: "kubernetes" (metered) or "other" (third-party, unmetered). */
  type: string;
  role: "agent" | "tool";
  /** The custom tool that ran, when role is "tool". */
  toolName?: string;
  cpuUsec: number;
}

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

export interface AgentDeploymentRecord {
  accountId: string;
  endpointId: string;
  projectSlug: string;
  environmentSlug: string;
}

/**
 * Project + environment scoped runtime keys, keyed by the dashboard/CLI-issued
 * API key hash. The key authorizes the account/environment scope; the agent is
 * chosen per request by id.
 */
export interface AgentDeploymentStore {
  getByApiKeyHash(apiKeyHash: string): Promise<AgentDeploymentRecord | null>;
  /** Resolve the environment deployment containing one linked runtime agent. */
  getByAgentId?(accountId: string, agentId: string): Promise<AgentDeploymentRecord | null>;
}

/** Account-scoped cron job schedules. */
export interface CronStore {
  getById(accountId: string, cronId: string): Promise<CronRecord | null>;
  list(accountId: string): Promise<CronRecord[]>;
  create(
    accountId: string,
    input: CreateCronInput,
    options: { schedulerGroupName: string },
  ): Promise<CronRecord>;
  update(accountId: string, cronId: string, patch: UpdateCronInput): Promise<CronRecord | null>;
  remove(accountId: string, cronId: string): Promise<boolean>;
  markStarted(accountId: string, cronId: string): Promise<void>;
  markCompleted(accountId: string, cronId: string): Promise<void>;
  markFailed(accountId: string, cronId: string, error: string): Promise<void>;
  createRun(input: Omit<CronRunRecord, "runId" | "status" | "startedAt">): Promise<CronRunRecord>;
  completeRun(accountId: string, cronId: string, runId: string, result: unknown): Promise<void>;
  failRun(accountId: string, cronId: string, runId: string, error: string): Promise<void>;
  listRuns(accountId: string, cronId: string, limit?: number): Promise<CronRunRecord[]>;
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

/**
 * Writes per-task usage counts. The active storage provider implements this;
 * it inserts one raw-count row per finished task and folds into a rollup
 * bucket (Convex: 5-min usageRollups; DynamoDB: ADD-atomic rollup item).
 */
export interface UsageStore {
  recordTask(input: UsageTaskInput): Promise<void>;
}

export interface StorageProvider {
  readonly kind: "dynamodb" | "convex";
  accounts: AccountStore;
  agents: AgentStore;
  agentDeployments: AgentDeploymentStore;
  crons: CronStore;
  sandboxConfigs: SandboxConfigStore;
  workspaceConfigs: WorkspaceConfigStore;
  accountTools: AccountToolStore;
  usage: UsageStore;
}
