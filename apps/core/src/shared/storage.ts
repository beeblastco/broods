import type { JSONValue } from "ai";
import type { AccountHookRecord } from "./domain/account-hooks.ts";
import type { McpRecord } from "./domain/mcp.ts";
import type { RolePrincipal } from "@broods/convex/model/apiAuthorization";
import type { ConnectionType } from "@broods/convex/model/connections";
import type { EncryptedBlob } from "@broods/convex/model/envelope";
import type { UsageQuantities } from "@broods/convex/model/pricing";
import type { R2Credentials } from "@broods/convex/model/r2Credentials";
import type { BudgetStatus } from "@broods/convex/model/usageMeter";
import type { AccountRecord, CreateAccountInput } from "./domain/accounts.ts";
import type { PolicyRecord } from "./domain/policy.ts";
import type { PrincipalLink } from "./domain/principal.ts";
import type { AgentRecord } from "./domain/agents.ts";
import type { ChannelRecord } from "./domain/channel-record.ts";
import type {
  CreateCronInput,
  CronRecord,
  CronRunRecord,
  UpdateCronInput,
} from "./domain/cron.ts";
import type { SandboxConfigRecord } from "./domain/sandbox-config.ts";
import type { SandboxSpecs } from "./sandbox-sizes.ts";
import type { WorkspaceConfigRecord } from "./domain/workspace-config.ts";

export interface AgentDeploymentScope {
  accountId: string;
  endpointId: string;
  projectSlug: string;
  stageSlug: string;
}

export interface TaskUsageInput {
  accountId: string;
  endpointId?: string;
  agentId: string;
  principalChain?: PrincipalLink[];
  conversationKey: string;
  /** `${eventId}#${traceId}`: one row per model pass. */
  taskId: string;
  modelProvider: string;
  modelId: string;
  finishedAt: number;
  durationMs: number;
  status: "completed" | "failed";
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  runtimeKind: string;
  runtimeWallMs: number;
  runtimeMemoryMb: number;
  sandboxUsage: SandboxUsageEntry[];
  stepCount: number;
  toolCallCount: number;
  inputPreview?: string;
}

export interface MachineConnectionRef {
  accountId: string;
  /** New on every connect, so a replaced connection's late writes miss. */
  connectionId: string;
  sandboxConfigId: string;
}

export interface MachineConnectionRecord extends MachineConnectionRef {
  computer: boolean;
  hostname?: string;
  mcp: string[];
  platform?: string;
  specs?: SandboxSpecs;
}

export interface SandboxUsageEntry {
  type: string;
  role: "agent" | "tool";
  toolName?: string;
  cpuUsec: number;
}

interface AccountStore {
  getById(accountId: string): Promise<AccountRecord | null>;
  getBySecretHash(secretHash: string): Promise<AccountRecord | null>;
  create(
    input: CreateAccountInput,
  ): Promise<{ account: AccountRecord; secret: string }>;
  disable(accountId: string): Promise<AccountRecord | null>;
  remove(accountId: string): Promise<boolean>;
}

interface AgentStore {
  getById(accountId: string, agentId: string): Promise<AgentRecord | null>;
  listForProduction(accountId: string): Promise<AgentRecord[]>;
  listForEndpoint(
    accountId: string,
    endpointId: string,
  ): Promise<AgentRecord[]>;
  listForStage(
    accountId: string,
    projectId: string,
    stageId: string,
  ): Promise<AgentRecord[]>;
  removeAllForAccount(accountId: string): Promise<number>;
}

interface ChannelRecordStore {
  getByExternalId(
    accountId: string,
    platform: string,
    externalId: string,
  ): Promise<ChannelRecord | null>;
  getById(
    accountId: string,
    channelRecordId: string,
  ): Promise<ChannelRecord | null>;
  list(accountId: string): Promise<ChannelRecord[]>;
  removeAllForAccount(accountId: string): Promise<number>;
}

interface AgentDeploymentStore {
  getByApiKeyHash(apiKeyHash: string): Promise<
    | (AgentDeploymentScope & {
        account: AccountRecord;
        userTokenSecret?: EncryptedBlob;
      })
    | null
  >;
  touchLastUsed(apiKeyHash: string, usedAt: number): Promise<void>;
  getByAgentId?(
    accountId: string,
    agentId: string,
  ): Promise<AgentDeploymentScope | null>;
}

interface CronStore {
  create(accountId: string, input: CreateCronInput): Promise<CronRecord>;
  getById(accountId: string, cronId: string): Promise<CronRecord | null>;
  list(accountId: string, agentId?: string): Promise<CronRecord[]>;
  remove(accountId: string, cronId: string): Promise<boolean>;
  // Null: the job is gone, possibly deleted while the patch was in flight.
  update(
    accountId: string,
    cronId: string,
    patch: UpdateCronInput,
  ): Promise<CronRecord | null>;
  // A fire that failed before its run row. `firedAt` keeps an older fire from showing over a newer.
  markFailed(
    accountId: string,
    cronId: string,
    error: string,
    firedAt: Date,
  ): Promise<void>;
  createRun(
    input: Omit<CronRunRecord, "runId" | "status" | "startedAt">,
    firedAt: Date,
  ): Promise<CronRunRecord>;
  completeRun(
    accountId: string,
    cronId: string,
    runId: string,
    result: JSONValue,
  ): Promise<void>;
  failRun(
    accountId: string,
    cronId: string,
    runId: string,
    error: string,
  ): Promise<void>;
}

interface MachineConnectionStore {
  connected(connection: MachineConnectionRecord): Promise<void>;
  disconnected(ref: MachineConnectionRef): Promise<void>;
  seen(ref: MachineConnectionRef): Promise<void>;
}

interface SandboxConfigStore {
  getById(
    accountId: string,
    sandboxId: string,
  ): Promise<SandboxConfigRecord | null>;
  list(accountId: string): Promise<SandboxConfigRecord[]>;
  removeAllForAccount(accountId: string): Promise<number>;
}

interface WorkspaceConfigStore {
  getById(
    accountId: string,
    workspaceId: string,
  ): Promise<WorkspaceConfigRecord | null>;
  list(accountId: string): Promise<WorkspaceConfigRecord[]>;
  storageExternalId(accountId: string): Promise<string>;
  mintR2Credentials(
    accountId: string,
    workspaceId: string,
    prefix: string,
  ): Promise<R2Credentials>;
  removeAllForAccount(accountId: string): Promise<number>;
}

interface AccountHookStore {
  getById(accountId: string, hookId: string): Promise<AccountHookRecord | null>;
  removeAllForAccount(accountId: string): Promise<number>;
}

interface McpStore {
  getById(accountId: string, serverId: string): Promise<McpRecord | null>;
  removeAllForAccount(accountId: string): Promise<number>;
}

interface AgentPolicyStore {
  getById(accountId: string, policyId: string): Promise<PolicyRecord | null>;
}

export interface StoredConnection {
  type: ConnectionType;
  clientId: string;
  scopes: string[];
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  updatedAt: number;
}

interface ConnectionStore {
  load(
    accountId: string,
    type: ConnectionType,
  ): Promise<StoredConnection | null>;
  /** False when `updatedAt` moved since `loaded` was read: a new sign-in wins. */
  saveRefreshed(
    accountId: string,
    type: ConnectionType,
    loaded: StoredConnection,
    refreshed: Pick<
      StoredConnection,
      "accessToken" | "refreshToken" | "expiresAt"
    >,
  ): Promise<boolean>;
}

interface RoleSessionStore {
  resolveByTokenHash(tokenHash: string): Promise<RolePrincipal | null>;
}

interface AccountApiKeyStore {
  resolveByKeyHash(keyHash: string): Promise<{
    keyId: string;
    account: AccountRecord;
    principal: RolePrincipal;
    stampDue: boolean;
  } | null>;
  touchLastUsed(keyId: string, usedAt: number): Promise<void>;
}

export interface UsageSource {
  projectId?: string;
  agentId?: string;
  workspaceId?: string;
}

interface BudgetStore {
  get(accountId: string): Promise<BudgetStatus | null>;
  /** Never throws: a failed write is retried, then logged with its usage. */
  record(
    accountId: string,
    usage: Pick<
      Partial<UsageQuantities>,
      | "hostedMcpGbSeconds"
      | "hostedMcpRequests"
      | "workerMs"
      | "workerRequests"
      | "egressGb"
      | "ingressGb"
    >,
    source?: UsageSource,
  ): Promise<void>;
  claimWarning(accountId: string): Promise<boolean>;
}

interface TaskUsageStore {
  record(input: TaskUsageInput): Promise<void>;
}

// run.completed rides the usage write instead, so the per-turn path gains no Convex call.
export interface AuditLedgerInput {
  accountId: string;
  agentId?: string;
  chain?: PrincipalLink[];
  traceId?: string;
  action: "tool.denied";
  resource: { kind: "tool"; name: string };
  summary: string;
  /** Ids, names and counts only: never tool input or secrets. */
  details?: Record<string, JSONValue | undefined>;
}

interface AuditLedgerStore {
  append(input: AuditLedgerInput): Promise<void>;
}

export interface Storage {
  auditLedger: AuditLedgerStore;
  accounts: AccountStore;
  accountApiKeys: AccountApiKeyStore;
  agents: AgentStore;
  budgets: BudgetStore;
  agentDeployments: AgentDeploymentStore;
  channelRecords: ChannelRecordStore;
  crons: CronStore;
  sandboxConfigs: SandboxConfigStore;
  workspaceConfigs: WorkspaceConfigStore;
  accountHooks: AccountHookStore;
  machineConnections: MachineConnectionStore;
  mcp: McpStore;
  agentPolicies: AgentPolicyStore;
  connections: ConnectionStore;
  roleSessions: RoleSessionStore;
  taskUsage: TaskUsageStore;
}

let cached: Storage | null = null;

export function getStorage(): Storage {
  if (cached) return cached;
  const { convexStorage } = require("./convex/storage.ts");
  cached = convexStorage as Storage;

  return cached;
}

export function resetStorageForTests(): void {
  cached = null;
}

export function setStorageForTests(store: Storage | null): void {
  cached = store;
}
