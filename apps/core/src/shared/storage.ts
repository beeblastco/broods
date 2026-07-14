/**
 * Runtime-facing data boundary for core. Convex is the only implementation;
 * domain records and configuration codecs live in `./domain/`.
 */

import type {
  AccountRecord,
  CreateAccountInput,
} from "./domain/accounts.ts";
import type { AgentRecord } from "./domain/agents.ts";
import type { CronRecord, CronRunRecord } from "./domain/cron.ts";
import type { SandboxConfigRecord } from "./domain/sandbox-config.ts";
import type { WorkspaceConfigRecord } from "./domain/workspace-config.ts";
import type { AccountToolRecord } from "./domain/account-tools.ts";
import type { AccountHookRecord } from "./domain/account-hooks.ts";
import type { AgentPolicyRecord } from "./domain/agent-policy.ts";

/**
 * Raw counts for one finished agent task. No dollar amounts — pricing is
 * computed at render time from a shared hardcoded table (plan §6d, §10a).
 *
 * endpointId is optional for account-key traffic that is not associated with
 * a dashboard deployment.
 */
export interface TaskUsageInput {
  accountId: string;
  /** Convex endpoint identifier when the task belongs to a deployment. */
  endpointId?: string;
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
  /** CPU per sandbox context; recorded for the self-hosted providers (sandbox/lambda). */
  sandboxUsage: SandboxUsageEntry[];
  /** Number of model steps executed in this task. */
  stepCount: number;
  /** Number of tool calls made across all steps. */
  toolCallCount: number;
}

/** One sandbox's CPU within a task: the agent's own sandbox or a per-tool sandbox. */
export interface SandboxUsageEntry {
  /** Sandbox provider type: self-hosted (sandbox/lambda, metered) or third-party (unmetered). */
  type: string;
  role: "agent" | "tool";
  /** The custom tool that ran, when role is "tool". */
  toolName?: string;
  cpuUsec: number;
}

/** Account operations retained by core for auth, standalone creation, and cleanup. */
export interface AccountStore {
  getById(accountId: string): Promise<AccountRecord | null>;
  getBySecretHash(secretHash: string): Promise<AccountRecord | null>;
  create(input: CreateAccountInput): Promise<{ account: AccountRecord; secret: string }>;
  disable(accountId: string): Promise<AccountRecord | null>;
  remove(accountId: string): Promise<boolean>;
}

/** Agent reads plus the explicit deletion cleanup used by core. */
export interface AgentStore {
  getById(accountId: string, agentId: string): Promise<AgentRecord | null>;
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
  remove(accountId: string, cronId: string): Promise<boolean>;
  markStarted(accountId: string, cronId: string): Promise<void>;
  markCompleted(accountId: string, cronId: string): Promise<void>;
  markFailed(accountId: string, cronId: string, error: string): Promise<void>;
  createRun(input: Omit<CronRunRecord, "runId" | "status" | "startedAt">): Promise<CronRunRecord>;
  completeRun(accountId: string, cronId: string, runId: string, result: unknown): Promise<void>;
  failRun(accountId: string, cronId: string, runId: string, error: string): Promise<void>;
}

/** Account-scoped, reusable sandbox config records (encrypted at rest). */
export interface SandboxConfigStore {
  getById(accountId: string, sandboxId: string): Promise<SandboxConfigRecord | null>;
  list(accountId: string): Promise<SandboxConfigRecord[]>;
  removeAllForAccount(accountId: string): Promise<number>;
}

/** Account-scoped, reusable workspace config records (plaintext, no secrets). */
export interface WorkspaceConfigStore {
  getById(accountId: string, workspaceId: string): Promise<WorkspaceConfigRecord | null>;
  list(accountId: string): Promise<WorkspaceConfigRecord[]>;
  removeAllForAccount(accountId: string): Promise<number>;
}

/** Account-scoped uploaded custom tool metadata. */
export interface AccountToolStore {
  getById(accountId: string, toolId: string): Promise<AccountToolRecord | null>;
  removeAllForAccount(accountId: string): Promise<number>;
}

/** Account-owned isolate code hooks. */
export interface AccountHookStore {
  getById(accountId: string, hookId: string): Promise<AccountHookRecord | null>;
  removeAllForAccount(accountId: string): Promise<number>;
}

/** Account-scoped reusable runtime authorization policies. */
export interface AgentPolicyStore {
  getById(accountId: string, policyId: string): Promise<AgentPolicyRecord | null>;
}

/**
 * Writes per-task usage counts. The Convex storage adapter implements this;
 * it inserts one raw-count row per finished task and folds into a rollup
 * 5-minute Convex usageRollups bucket.
 */
export interface TaskUsageStore {
  record(input: TaskUsageInput): Promise<void>;
}

export interface Storage {
  accounts: AccountStore;
  agents: AgentStore;
  agentDeployments: AgentDeploymentStore;
  crons: CronStore;
  sandboxConfigs: SandboxConfigStore;
  workspaceConfigs: WorkspaceConfigStore;
  accountTools: AccountToolStore;
  accountHooks: AccountHookStore;
  agentPolicies: AgentPolicyStore;
  taskUsage: TaskUsageStore;
}

let cached: Storage | null = null;

/** Returns the process-wide Convex-backed storage boundary. */
export function getStorage(): Storage {
  if (cached) return cached;
  const { convexStorage } = require("./convex/storage.ts");
  cached = convexStorage as Storage;

  return cached;
}

/** Resets the cached store. Tests only. */
export function resetStorageForTests(): void {
  cached = null;
}

/** Injects a store for focused tests. */
export function setStorageForTests(store: Storage | null): void {
  cached = store;
}
