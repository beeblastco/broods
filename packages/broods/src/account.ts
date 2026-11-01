// Edge-safe (`broods/account`): fetch only, no Node built-ins or .env loading, so it runs in
// Convex actions and Cloudflare Workers as well as Node and Bun.

import type {
  ChannelPartition,
  AgentConfig,
  ChannelReplyIn,
  PolicyDocument,
  CreateCronInput,
  SandboxConfig,
  UpdateCronInput,
  WorkspaceConfig,
} from "./contracts.ts";
import type { Cron, CronRun, Skill } from "./types.ts";
import type {
  Connection,
  ConnectionCode,
  ConnectionStart,
  ConnectionStartResult,
  ConnectionType,
} from "../../convex/model/connections.ts";

// Copy of `DEFAULT_CORE_BASE_URL`: importing client.ts would pull in Node-only code.
const DEFAULT_ACCOUNT_BASE_URL = "https://gateway.broods.app";
const ACCOUNT_ENV_VAR_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** Objects merge key by key, `null` deletes a key, arrays and scalars replace. */
export type ConfigPatch<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: ConfigPatch<T[K]> | null }
    : T;

export interface BroodsAccountClientOptions {
  baseUrl?: string;
  accountSecret?: string;
  /** From {@link BroodsAccountClient.assumeRole}; wins over `accountSecret`. */
  sessionToken?: string;
  fetch?: typeof fetch;
}

export interface BroodsAccount {
  accountId: string;
  username: string;
  status: string;
  /** Absent means the 90 day default. */
  auditRetentionDays?: number;
  [key: string]: unknown;
}

/** `config` secrets come back redacted as `********`. */
export interface AccountAgent {
  accountId: string;
  agentId: string;
  name: string;
  description?: string;
  status: string;
  config: AgentConfig;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentResult {
  accountId: string;
  agentId: string;
  name: string;
  description?: string;
}

export interface AccountEnvVar {
  name: string;
  updatedAt: string;
}

export type {
  Connection,
  ConnectionCode,
  ConnectionStart,
  ConnectionStartResult,
  ConnectionType,
};

export interface UpdateAgentInput {
  name?: string;
  description?: string | null;
  config?: ConfigPatch<AgentConfig>;
}

export interface AccountWorkspace {
  accountId: string;
  workspaceId: string;
  name: string;
  description?: string;
  config: WorkspaceConfig;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceFileEntry {
  path: string;
  name: string;
  isFolder: boolean;
  sizeBytes?: number;
  updatedAt?: string;
}

/** `config` secrets such as `envVars` come back redacted. */
export interface AccountSandbox {
  accountId: string;
  sandboxId: string;
  name: string;
  description?: string;
  config: SandboxConfig;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface AccountPolicy {
  accountId: string;
  policyId: string;
  name: string;
  description?: string;
  document: PolicyDocument;
  status: string;
  createdAt: string;
  updatedAt: string;
}

/** `policy` uses API actions (`agents:read`); `projectId` + `stageId` bound who may assume it. */
export interface AccountRole {
  accountId: string;
  roleId: string;
  name: string;
  projectId?: string;
  stageId?: string;
  status: "active" | "disabled";
  policy: PolicyDocument;
  createdAt: string;
  updatedAt: string;
}

export type AuditPrincipalLink =
  | { kind: "user"; id: string; name?: string; channel?: string }
  | { kind: "api"; keyKind: "account" | "deployment" | "cron" }
  | { kind: "agent"; agentId: string };

/**
 * `hash` is sha256 of the canonical JSON of every other field (an absent optional is left
 * out, not null); `prevHash` is the previous row's `hash`.
 */
export interface AuditEvent {
  accountId: string;
  seq: number;
  prevHash: string;
  hash: string;
  /** Unix ms. */
  at: number;
  actor: {
    kind: string;
    id?: string;
    email?: string;
    name?: string;
    agentId?: string;
    /** On an agent actor: who asked, then each agent that delegated, oldest first. */
    chain?: AuditPrincipalLink[];
  };
  action: string;
  resource: { kind: string; id?: string; name?: string };
  summary: string;
  detailsJson?: string;
  projectId?: string;
  stageId?: string;
  traceId?: string;
}

export interface AuditPage {
  events: AuditEvent[];
  nextSince: number;
  head: { seq: number; hash: string } | null;
}

export interface AuditVerification {
  ok: boolean;
  brokenAtSeq?: number;
  checkedFrom?: number;
  checkedTo?: number;
}

export interface AuditSink {
  kind: "webhook";
  url: string;
  exportedSeq: number;
  lastError?: string;
  updatedAt: string;
}

export interface AssumeRoleResult {
  token: string;
  expiresAt: string;
}

export interface AccountChannel {
  accountId: string;
  channelId: string;
  platform: string;
  externalId: string;
  workspaceRef?: string;
  name: string;
  description?: string;
  config: ChannelRecordConfig;
  status: "active" | "deleted";
  createdAt: string;
  updatedAt: string;
}

/** A channel record narrows and adds; it never grants capability the agent lacks. */
export interface ChannelRecordConfig {
  /** Appended after the agent's own system prompt. */
  instructions?: string;
  agentBindings: Array<{ agentId: string; isDefault?: boolean }>;
  workspaces?: Array<{ name: string; workspaceId: string }>;
  policies?: string[];
  /** Also covers sandbox tools (`bash`, `read`, …); unknown names are ignored. */
  denyTools?: string[];
  /** Slack only. `source` replies where the message came from, threading only if it was. */
  replyIn?: ChannelReplyIn;
  partition?: ChannelPartition;
  sandboxImages?: string[];
  /** Readable from policy conditions as `userRoles`. */
  tagRoles?: Array<{ roleId: string; userIds: string[] }>;
}

export interface StageScope {
  project: string;
  stage: string;
}

/**
 * Refresh-token grant; the runtime mints the Bearer itself. `clientSecret` and `refreshToken`
 * must be `${NAME}` env refs; `tokenUrl` defaults to https://oauth2.googleapis.com/token.
 */
export interface McpOauthInput {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenUrl?: string;
}

/** `auto` (the default) runs a hosted bundle on Cloudflare Workers when it can, else Lambda. */
export type McpRuntime = "auto" | "lambda";

export interface AccountMcp {
  accountId: string;
  serverId: string;
  projectId: string;
  stageId: string;
  name: string;
  description?: string;
  /** `http` sets `url`, `hosted` sets `sha256`/`runtime`, `machine` sets `sandbox`/`command`. */
  transport: "http" | "hosted" | "machine";
  url?: string;
  sandbox?: string;
  command?: string[];
  sha256?: string;
  runtime?: McpRuntime;
  headers?: Record<string, string>;
  oauth?: McpOauthInput;
  allowedTools?: string[];
  disabled: boolean;
  status: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

/** `bundle` inline is ≤10 MB, a larger one goes through `uploadMcpBundle` first. */
export interface CreateMcpInput {
  name: string;
  description?: string;
  url?: string;
  sandbox?: string;
  command?: string[];
  bundle?: string;
  bundleStorageId?: string;
  sha256?: string;
  headers?: Record<string, string>;
  oauth?: McpOauthInput;
  allowedTools?: string[];
  runtime?: McpRuntime;
}

export interface UpdateMcpInput {
  name?: string;
  description?: string;
  url?: string;
  sandbox?: string;
  command?: string[];
  bundle?: string;
  bundleStorageId?: string;
  sha256?: string;
  headers?: Record<string, string>;
  oauth?: McpOauthInput;
  allowedTools?: string[];
  runtime?: McpRuntime;
  disabled?: boolean;
}

/** `json` needs name, description, content; `files` a root `SKILL.md`; `github` a tree `url`. */
export interface SkillUploadInput {
  source: "json" | "files" | "github";
  name?: string;
  description?: string;
  content?: string;
  files?: Array<{ path: string; contentBase64: string; contentType?: string }>;
  url?: string;
}

export interface RotateSecretResult {
  account: BroodsAccount;
  secret: string;
}

/**
 * `externalId` is per account and sent on every AssumeRole; it is never set in config.
 * `principalArn` and `trustPolicy` are absent on a deployment with no AWS.
 */
export interface StorageTrust {
  externalId: string;
  principalArn?: string;
  trustPolicy?: string;
}

export interface DeleteAccountResult {
  deleted: boolean;
  cleanup?: Record<string, number>;
}

export interface SandboxLifecycleResult {
  status: string;
}

export interface SandboxSnapshotResult {
  status: string;
  snapshotId?: string;
  externalImageId?: string;
}

export interface SandboxTerminalTicket {
  token: string;
  expiresAt: number;
  websocketPath: string;
}

export class BroodsAccountApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(method: string, path: string, status: number, body: string) {
    super(`${method} ${path} failed with ${status}: ${body}`);
    this.name = "BroodsAccountApiError";
    this.status = status;
    this.body = body;
  }
}

declare const process: { env?: Record<string, string | undefined> } | undefined;

export function envPlaceholder(name: string): string {
  if (!ACCOUNT_ENV_VAR_NAME_PATTERN.test(name) || name.length > 64) {
    throw new Error(
      "envPlaceholder name must match /^[A-Z][A-Z0-9_]*$/ and be at most 64 characters.",
    );
  }

  return `\${${name}}`;
}

/** The constructor's env fallback, for callers that must not throw without one. */
export function resolveEnvCredential(): string | undefined {
  return envVar("BROODS_SESSION_TOKEN") ?? envVar("BROODS_ACCOUNT_SECRET");
}

/**
 * Lookups, updates and deletes return `null`/`false` on a 404, so upserts need no try/catch.
 * Any other failure throws {@link BroodsAccountApiError}.
 */
export class BroodsAccountClient {
  private readonly baseUrl: string;
  private readonly bearerToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BroodsAccountClientOptions = {}) {
    const baseUrl =
      options.baseUrl ?? envVar("BROODS_BASE_URL") ?? DEFAULT_ACCOUNT_BASE_URL;
    const bearerToken =
      options.sessionToken ?? options.accountSecret ?? resolveEnvCredential();
    if (!bearerToken)
      throw new Error(
        "BroodsAccountClient requires an accountSecret or sessionToken (or BROODS_ACCOUNT_SECRET / BROODS_SESSION_TOKEN).",
      );
    let baseUrlEnd = baseUrl.length;
    while (baseUrlEnd > 0 && baseUrl.charCodeAt(baseUrlEnd - 1) === 47)
      baseUrlEnd -= 1;
    this.baseUrl = baseUrl.slice(0, baseUrlEnd);
    this.bearerToken = bearerToken;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async getAccount(): Promise<BroodsAccount> {
    const result = await this.request<{ account: BroodsAccount }>(
      "GET",
      "/v1/account",
    );
    if (!result)
      throw new BroodsAccountApiError(
        "GET",
        "/v1/account",
        404,
        "Account not found",
      );

    return result.account;
  }

  async getStorageTrust(): Promise<StorageTrust> {
    const result = await this.request<{ storageTrust: StorageTrust }>(
      "GET",
      "/v1/account/storage-trust",
    );
    if (!result)
      throw new BroodsAccountApiError(
        "GET",
        "/v1/account/storage-trust",
        404,
        "Account not found",
      );

    return result.storageTrust;
  }

  async updateAccount(patch: {
    username?: string;
    description?: string | null;
    /** 1 to 3650 days, or null for the 90 day default. */
    auditRetentionDays?: number | null;
  }): Promise<BroodsAccount | null> {
    const result = await this.request<{ account: BroodsAccount }>(
      "PATCH",
      "/v1/account",
      patch,
    );

    return result?.account ?? null;
  }

  /**
   * A runtime key may assume only roles scoped to its own project and stage.
   * Act as the role with `new BroodsAccountClient({ sessionToken: result.token })`.
   */
  async assumeRole(
    roleId: string,
    options: { ttlSeconds?: number } = {},
  ): Promise<AssumeRoleResult> {
    const result = await this.request<AssumeRoleResult>(
      "POST",
      "/v1/account/assume-role",
      {
        roleId: roleId,
        ...(options.ttlSeconds !== undefined
          ? { ttlSeconds: options.ttlSeconds }
          : {}),
      },
    );
    if (!result)
      throw new BroodsAccountApiError(
        "POST",
        "/v1/account/assume-role",
        404,
        "Role not found",
      );

    return result;
  }

  /** The old key dies at once and `secret` is shown only once: persist it before exiting. */
  async rotateSecret(): Promise<RotateSecretResult> {
    const result = await this.request<RotateSecretResult>(
      "POST",
      "/v1/account/rotate-secret",
    );
    if (!result)
      throw new BroodsAccountApiError(
        "POST",
        "/v1/account/rotate-secret",
        404,
        "Account not found",
      );

    return result;
  }

  async deleteAccount(): Promise<DeleteAccountResult> {
    const result = await this.request<DeleteAccountResult>(
      "DELETE",
      "/v1/account",
    );

    return result ?? { deleted: false };
  }

  /** One URL per account and channel type; the credentials that verify a request pick the agent. */
  webhookUrl(accountId: string, channelType: string): string {
    const segments = [accountId, channelType].map(encodeURIComponent);

    return `${this.baseUrl}/v1/webhooks/${segments.join("/")}`;
  }

  async listAgents(): Promise<AccountAgent[]> {
    const result = await this.request<{ agents: AccountAgent[] }>(
      "GET",
      "/v1/agents",
    );

    return result?.agents ?? [];
  }

  async createAgent(input: {
    name: string;
    description?: string;
    config: AgentConfig;
  }): Promise<CreateAgentResult> {
    const result = await this.request<CreateAgentResult>(
      "POST",
      "/v1/agents",
      input,
    );
    if (!result)
      throw new BroodsAccountApiError("POST", "/v1/agents", 404, "Not found");

    return result;
  }

  async getAgent(agentId: string): Promise<AccountAgent | null> {
    return await this.request<AccountAgent>(
      "GET",
      `/v1/agents/${encodeURIComponent(agentId)}`,
    );
  }

  async updateAgent(
    agentId: string,
    patch: UpdateAgentInput,
  ): Promise<AccountAgent | null> {
    return await this.request<AccountAgent>(
      "PATCH",
      `/v1/agents/${encodeURIComponent(agentId)}`,
      patch,
    );
  }

  async deleteAgent(agentId: string): Promise<boolean> {
    const result = await this.request<{ deleted: boolean }>(
      "DELETE",
      `/v1/agents/${encodeURIComponent(agentId)}`,
    );

    return result?.deleted ?? false;
  }

  async listEnvVars(): Promise<AccountEnvVar[]> {
    const result = await this.request<{ env: AccountEnvVar[] }>(
      "GET",
      "/v1/env",
    );

    return result?.env ?? [];
  }

  async setEnvVar(name: string, value: string): Promise<void> {
    await this.request<{ name: string }>(
      "PUT",
      `/v1/env/${encodeURIComponent(name)}`,
      { value: value },
    );
  }

  async deleteEnvVar(name: string): Promise<boolean> {
    const result = await this.request<{ deleted: boolean }>(
      "DELETE",
      `/v1/env/${encodeURIComponent(name)}`,
    );

    return result?.deleted ?? false;
  }

  async listConnections(): Promise<Connection[]> {
    const result = await this.request<{ connections: Connection[] }>(
      "GET",
      "/v1/account/connections",
    );

    return result?.connections ?? [];
  }

  async getConnection(type: ConnectionType): Promise<Connection | null> {
    return await this.request<Connection>(
      "GET",
      `/v1/account/connections/${type}`,
    );
  }

  async startConnection(
    type: ConnectionType,
    start: ConnectionStart,
  ): Promise<ConnectionStartResult> {
    const result = await this.request<ConnectionStartResult>(
      "POST",
      `/v1/account/connections/${type}/start`,
      start,
    );
    if (!result)
      throw new BroodsAccountApiError(
        "POST",
        `/v1/account/connections/${type}/start`,
        404,
        "This deployment has no /v1/account/connections yet",
      );

    return result;
  }

  async connect(
    type: ConnectionType,
    code: ConnectionCode,
  ): Promise<Connection> {
    const result = await this.request<Connection>(
      "PUT",
      `/v1/account/connections/${type}`,
      code,
    );
    if (!result)
      throw new BroodsAccountApiError(
        "PUT",
        `/v1/account/connections/${type}`,
        404,
        "This deployment has no /v1/account/connections yet",
      );

    return result;
  }

  async disconnect(type: ConnectionType): Promise<boolean> {
    const result = await this.request<{ deleted: boolean }>(
      "DELETE",
      `/v1/account/connections/${type}`,
    );

    return result?.deleted ?? false;
  }

  async listCrons(): Promise<Cron[]> {
    const result = await this.request<{ crons: Cron[] }>("GET", "/v1/crons");

    return result?.crons ?? [];
  }

  async createCron(input: CreateCronInput): Promise<Cron> {
    const result = await this.request<Cron>("POST", "/v1/crons", input);
    if (!result)
      throw new BroodsAccountApiError("POST", "/v1/crons", 404, "Not found");

    return result;
  }

  async getCron(cronId: string): Promise<Cron | null> {
    return await this.request<Cron>(
      "GET",
      `/v1/crons/${encodeURIComponent(cronId)}`,
    );
  }

  async updateCron(
    cronId: string,
    patch: UpdateCronInput,
  ): Promise<Cron | null> {
    return await this.request<Cron>(
      "PATCH",
      `/v1/crons/${encodeURIComponent(cronId)}`,
      patch,
    );
  }

  async deleteCron(cronId: string): Promise<boolean> {
    const result = await this.request<{ deleted: boolean }>(
      "DELETE",
      `/v1/crons/${encodeURIComponent(cronId)}`,
    );

    return result?.deleted ?? false;
  }

  /** Newest first. */
  async listCronRuns(
    cronId: string,
    options: { limit?: number } = {},
  ): Promise<CronRun[]> {
    const query = options.limit !== undefined ? `?limit=${options.limit}` : "";
    const result = await this.request<{ runs: CronRun[] }>(
      "GET",
      `/v1/crons/${encodeURIComponent(cronId)}/runs${query}`,
    );

    return result?.runs ?? [];
  }

  async listWorkspaces(): Promise<AccountWorkspace[]> {
    const result = await this.request<{ workspaces: AccountWorkspace[] }>(
      "GET",
      "/v1/workspaces",
    );

    return result?.workspaces ?? [];
  }

  async createWorkspace(input: {
    name: string;
    description?: string;
    config?: WorkspaceConfig;
  }): Promise<AccountWorkspace> {
    const result = await this.request<AccountWorkspace>(
      "POST",
      "/v1/workspaces",
      input,
    );
    if (!result)
      throw new BroodsAccountApiError(
        "POST",
        "/v1/workspaces",
        404,
        "Not found",
      );

    return result;
  }

  async getWorkspace(workspaceId: string): Promise<AccountWorkspace | null> {
    return await this.request<AccountWorkspace>(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}`,
    );
  }

  async updateWorkspace(
    workspaceId: string,
    patch: {
      name?: string;
      description?: string | null;
      config?: ConfigPatch<WorkspaceConfig>;
    },
  ): Promise<AccountWorkspace | null> {
    return await this.request<AccountWorkspace>(
      "PATCH",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}`,
      patch,
    );
  }

  async deleteWorkspace(workspaceId: string): Promise<boolean> {
    const result = await this.request<{ deleted: boolean }>(
      "DELETE",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}`,
    );

    return result?.deleted ?? false;
  }

  async listWorkspaceFiles(workspaceId: string): Promise<WorkspaceFileEntry[]> {
    const result = await this.request<{ files: WorkspaceFileEntry[] }>(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/files`,
    );

    return result?.files ?? [];
  }

  async getWorkspaceFileUrl(
    workspaceId: string,
    path: string,
  ): Promise<string | null> {
    const query = `?path=${encodeURIComponent(path)}`;
    const result = await this.request<{ url: string }>(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/files${query}`,
    );

    return result?.url ?? null;
  }

  async uploadWorkspaceFile(
    workspaceId: string,
    input: { path: string; contentBase64: string; contentType?: string },
  ): Promise<WorkspaceFileEntry> {
    const path = `/v1/workspaces/${encodeURIComponent(workspaceId)}/files`;
    const result = await this.request<{ file: WorkspaceFileEntry }>(
      "POST",
      path,
      input,
    );
    if (!result)
      throw new BroodsAccountApiError("POST", path, 404, "Workspace not found");

    return result.file;
  }

  async renameWorkspaceFile(
    workspaceId: string,
    path: string,
    newPath: string,
  ): Promise<number> {
    const filesPath = `/v1/workspaces/${encodeURIComponent(workspaceId)}/files`;
    const result = await this.request<{ renamed: number }>("PATCH", filesPath, {
      path: path,
      newPath: newPath,
    });
    if (!result)
      throw new BroodsAccountApiError(
        "PATCH",
        filesPath,
        404,
        "Workspace not found",
      );

    return result.renamed;
  }

  async deleteWorkspaceFile(
    workspaceId: string,
    path: string,
  ): Promise<number> {
    const result = await this.request<{ deleted: number }>(
      "DELETE",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/files`,
      { path: path },
    );

    return result?.deleted ?? 0;
  }

  async listSandboxes(): Promise<AccountSandbox[]> {
    const result = await this.request<{ sandboxes: AccountSandbox[] }>(
      "GET",
      "/v1/sandboxes",
    );

    return result?.sandboxes ?? [];
  }

  async createSandbox(input: {
    name: string;
    description?: string;
    config?: SandboxConfig;
  }): Promise<AccountSandbox> {
    const result = await this.request<AccountSandbox>(
      "POST",
      "/v1/sandboxes",
      input,
    );
    if (!result)
      throw new BroodsAccountApiError(
        "POST",
        "/v1/sandboxes",
        404,
        "Not found",
      );

    return result;
  }

  async getSandbox(sandboxId: string): Promise<AccountSandbox | null> {
    return await this.request<AccountSandbox>(
      "GET",
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}`,
    );
  }

  async updateSandbox(
    sandboxId: string,
    patch: {
      name?: string;
      description?: string | null;
      config?: ConfigPatch<SandboxConfig>;
    },
  ): Promise<AccountSandbox | null> {
    return await this.request<AccountSandbox>(
      "PATCH",
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}`,
      patch,
    );
  }

  async deleteSandbox(sandboxId: string): Promise<boolean> {
    const result = await this.request<{ deleted: boolean }>(
      "DELETE",
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}`,
    );

    return result?.deleted ?? false;
  }

  async suspendSandbox(
    sandboxId: string,
    reservationKey: string,
  ): Promise<SandboxLifecycleResult> {
    return await this.sandboxAction<SandboxLifecycleResult>(
      sandboxId,
      "suspend",
      { reservationKey: reservationKey },
    );
  }

  async resumeSandbox(
    sandboxId: string,
    reservationKey: string,
  ): Promise<SandboxLifecycleResult> {
    return await this.sandboxAction<SandboxLifecycleResult>(
      sandboxId,
      "resume",
      { reservationKey: reservationKey },
    );
  }

  async terminateSandbox(
    sandboxId: string,
    reservationKey: string,
  ): Promise<SandboxLifecycleResult> {
    return await this.sandboxAction<SandboxLifecycleResult>(
      sandboxId,
      "terminate",
      { reservationKey: reservationKey },
    );
  }

  /**
   * Providers `sandbox`, `daytona`, `e2b`, `vercel` and `lambda` (`building` until its image
   * lands). Only the source stage may pin the snapshot; any other stage gets a 400.
   */
  async snapshotSandbox(
    sandboxId: string,
    reservationKey: string,
    name: string,
  ): Promise<SandboxSnapshotResult> {
    return await this.sandboxAction<SandboxSnapshotResult>(
      sandboxId,
      "snapshot",
      { reservationKey: reservationKey, name: name },
    );
  }

  /** Providers `sandbox`, `lambda` and `cloudflare` only. */
  async openSandboxTerminal(
    sandboxId: string,
    reservationKey: string,
  ): Promise<SandboxTerminalTicket> {
    return await this.sandboxAction<SandboxTerminalTicket>(
      sandboxId,
      "terminal",
      { reservationKey: reservationKey },
    );
  }

  async listMcp(scope: StageScope): Promise<AccountMcp[]> {
    const path = `/v1/mcp${stageScopeQuery(scope)}`;
    const result = await this.request<{ servers: AccountMcp[] }>("GET", path);
    if (!result) throw new BroodsAccountApiError("GET", path, 404, "Not found");

    return result.servers ?? [];
  }

  async createMcp(
    scope: StageScope,
    input: CreateMcpInput,
  ): Promise<AccountMcp> {
    const path = `/v1/mcp${stageScopeQuery(scope)}`;
    const result = await this.request<AccountMcp>("POST", path, input);
    if (!result)
      throw new BroodsAccountApiError("POST", path, 404, "Not found");

    return result;
  }

  async uploadMcpBundle(
    bundle: string,
  ): Promise<{ bundleStorageId: string; sha256: string }> {
    const path = "/v1/mcp/uploads";
    const minted = await this.request<{ uploadUrl: string }>("POST", path);
    if (!minted?.uploadUrl)
      throw new BroodsAccountApiError(
        "POST",
        path,
        502,
        "response omitted uploadUrl",
      );
    const stored = await this.fetchImpl(minted.uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/javascript" },
      body: bundle,
    });
    if (!stored.ok) {
      throw new BroodsAccountApiError(
        "POST",
        path,
        stored.status,
        await stored.text(),
      );
    }
    const { storageId } = (await stored.json()) as { storageId?: string };
    if (!storageId)
      throw new BroodsAccountApiError(
        "POST",
        path,
        502,
        "upload response omitted storageId",
      );
    const digestBytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(bundle),
    );
    const digest = Array.from(new Uint8Array(digestBytes))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    return { bundleStorageId: storageId, sha256: digest };
  }

  async getMcp(serverId: string): Promise<AccountMcp | null> {
    return await this.request<AccountMcp>(
      "GET",
      `/v1/mcp/${encodeURIComponent(serverId)}`,
    );
  }

  async updateMcp(
    serverId: string,
    patch: UpdateMcpInput,
  ): Promise<AccountMcp | null> {
    return await this.request<AccountMcp>(
      "PATCH",
      `/v1/mcp/${encodeURIComponent(serverId)}`,
      patch,
    );
  }

  async deleteMcp(serverId: string): Promise<boolean> {
    const result = await this.request<{ deleted: boolean }>(
      "DELETE",
      `/v1/mcp/${encodeURIComponent(serverId)}`,
    );

    return result?.deleted ?? false;
  }

  async listPolicies(): Promise<AccountPolicy[]> {
    const result = await this.request<{ policies: AccountPolicy[] }>(
      "GET",
      "/v1/policies",
    );

    return result?.policies ?? [];
  }

  async createPolicy(input: {
    name: string;
    description?: string;
    document: PolicyDocument;
  }): Promise<AccountPolicy> {
    const result = await this.request<AccountPolicy>(
      "POST",
      "/v1/policies",
      input,
    );
    if (!result)
      throw new BroodsAccountApiError("POST", "/v1/policies", 404, "Not found");

    return result;
  }

  async getPolicy(policyId: string): Promise<AccountPolicy | null> {
    return await this.request<AccountPolicy>(
      "GET",
      `/v1/policies/${encodeURIComponent(policyId)}`,
    );
  }

  async updatePolicy(
    policyId: string,
    patch: {
      name?: string;
      description?: string | null;
      document?: PolicyDocument;
      status?: string;
    },
  ): Promise<AccountPolicy | null> {
    return await this.request<AccountPolicy>(
      "PATCH",
      `/v1/policies/${encodeURIComponent(policyId)}`,
      patch,
    );
  }

  async deletePolicy(policyId: string): Promise<boolean> {
    const result = await this.request<{ deleted: boolean }>(
      "DELETE",
      `/v1/policies/${encodeURIComponent(policyId)}`,
    );

    return result?.deleted ?? false;
  }

  /** Roles need the account key: a session cannot list, mint, or edit them. */
  async listRoles(): Promise<AccountRole[]> {
    const result = await this.request<{ roles: AccountRole[] }>(
      "GET",
      "/v1/roles",
    );

    return result?.roles ?? [];
  }

  async createRole(input: {
    name: string;
    policy: PolicyDocument;
    projectId?: string;
    stageId?: string;
  }): Promise<AccountRole> {
    const result = await this.request<AccountRole>("POST", "/v1/roles", input);
    if (!result)
      throw new BroodsAccountApiError("POST", "/v1/roles", 404, "Not found");

    return result;
  }

  async getRole(roleId: string): Promise<AccountRole | null> {
    return await this.request<AccountRole>(
      "GET",
      `/v1/roles/${encodeURIComponent(roleId)}`,
    );
  }

  /** `status: "disabled"` kills every live session of the role. */
  async updateRole(
    roleId: string,
    patch: {
      name?: string;
      policy?: PolicyDocument;
      status?: "active" | "disabled";
    },
  ): Promise<AccountRole | null> {
    return await this.request<AccountRole>(
      "PATCH",
      `/v1/roles/${encodeURIComponent(roleId)}`,
      patch,
    );
  }

  async deleteRole(roleId: string): Promise<boolean> {
    const result = await this.request<{ deleted: boolean }>(
      "DELETE",
      `/v1/roles/${encodeURIComponent(roleId)}`,
    );

    return result?.deleted ?? false;
  }

  readonly audit = {
    /** Rows with `seq > since`, oldest first; `limit` defaults to 100, max 500. */
    list: async (
      options: { since?: number; limit?: number } = {},
    ): Promise<AuditPage> => {
      const result = await this.request<AuditPage>(
        "GET",
        `/v1/audit${optionalQuery(options)}`,
      );
      if (!result)
        throw new BroodsAccountApiError("GET", "/v1/audit", 404, "Not found");

      return result;
    },
    /**
     * At most 1000 rows per call: `ok` covers only `checkedFrom` to `checkedTo`, so on a longer
     * ledger call again with `fromSeq: checkedTo + 1`.
     */
    verify: async (
      options: { fromSeq?: number; toSeq?: number } = {},
    ): Promise<AuditVerification> => {
      const result = await this.request<AuditVerification>(
        "GET",
        `/v1/audit/verify${optionalQuery(options)}`,
      );
      if (!result)
        throw new BroodsAccountApiError(
          "GET",
          "/v1/audit/verify",
          404,
          "Not found",
        );

      return result;
    },
    getSink: async (): Promise<AuditSink | null> => {
      return await this.request<AuditSink>("GET", "/v1/audit/sink");
    },
    /** `url` must be public https; `secret` signs each batch. */
    setSink: async (input: {
      url: string;
      secret: string;
    }): Promise<AuditSink> => {
      const result = await this.request<AuditSink>(
        "PUT",
        "/v1/audit/sink",
        input,
      );
      if (!result)
        throw new BroodsAccountApiError(
          "PUT",
          "/v1/audit/sink",
          404,
          "Not found",
        );

      return result;
    },
    deleteSink: async (): Promise<boolean> => {
      const result = await this.request<{ deleted: boolean }>(
        "DELETE",
        "/v1/audit/sink",
      );

      return result?.deleted ?? false;
    },
  };

  async listChannels(): Promise<AccountChannel[]> {
    const result = await this.request<{ channels: AccountChannel[] }>(
      "GET",
      "/v1/channels",
    );

    return result?.channels ?? [];
  }

  async createChannel(input: {
    platform: string;
    externalId: string;
    workspaceRef?: string;
    name: string;
    description?: string;
    config: ChannelRecordConfig;
  }): Promise<AccountChannel> {
    const result = await this.request<AccountChannel>(
      "POST",
      "/v1/channels",
      input,
    );
    if (!result)
      throw new BroodsAccountApiError("POST", "/v1/channels", 404, "Not found");

    return result;
  }

  async getChannel(channelId: string): Promise<AccountChannel | null> {
    return await this.request<AccountChannel>(
      "GET",
      `/v1/channels/${encodeURIComponent(channelId)}`,
    );
  }

  async updateChannel(
    channelId: string,
    patch: {
      name?: string;
      description?: string | null;
      workspaceRef?: string | null;
      config?: ChannelRecordConfig;
      status?: "active" | "deleted";
    },
  ): Promise<AccountChannel | null> {
    return await this.request<AccountChannel>(
      "PATCH",
      `/v1/channels/${encodeURIComponent(channelId)}`,
      patch,
    );
  }

  async deleteChannel(channelId: string): Promise<boolean> {
    const result = await this.request<{ deleted: boolean }>(
      "DELETE",
      `/v1/channels/${encodeURIComponent(channelId)}`,
    );

    return result?.deleted ?? false;
  }

  async listSkills(): Promise<Skill[]> {
    const result = await this.request<{ skills: Skill[] }>("GET", "/v1/skills");

    return result?.skills ?? [];
  }

  async createSkill(input: SkillUploadInput): Promise<Skill> {
    const result = await this.request<Skill>("POST", "/v1/skills", input);
    if (!result)
      throw new BroodsAccountApiError("POST", "/v1/skills", 404, "Not found");

    return result;
  }

  async getSkill(skillName: string): Promise<Skill | null> {
    return await this.request<Skill>(
      "GET",
      `/v1/skills/${encodeURIComponent(skillName)}`,
    );
  }

  async uploadSkill(
    skillName: string,
    input: SkillUploadInput,
  ): Promise<Skill> {
    const path = `/v1/skills/${encodeURIComponent(skillName)}`;
    const result = await this.request<Skill>("PUT", path, input);
    if (!result)
      throw new BroodsAccountApiError("PUT", path, 404, "Skill not found");

    return result;
  }

  async deleteSkill(skillName: string): Promise<boolean> {
    const result = await this.request<{ deleted: boolean }>(
      "DELETE",
      `/v1/skills/${encodeURIComponent(skillName)}`,
    );

    return result?.deleted ?? false;
  }

  private async sandboxAction<T>(
    sandboxId: string,
    action: string,
    body: unknown,
  ): Promise<T> {
    const path = `/v1/sandboxes/${encodeURIComponent(sandboxId)}/${action}`;
    const result = await this.request<T>("POST", path, body);
    if (!result)
      throw new BroodsAccountApiError("POST", path, 404, "Sandbox not found");

    return result;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T | null> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: method,
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new BroodsAccountApiError(
        method,
        path,
        response.status,
        await response.text(),
      );
    }

    return (await response.json()) as T;
  }
}

function envVar(name: string): string | undefined {
  return typeof process !== "undefined" ? process?.env?.[name] : undefined;
}

function optionalQuery(params: Record<string, number | undefined>): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) query.set(name, String(value));
  }

  return query.size > 0 ? `?${query.toString()}` : "";
}

function stageScopeQuery(scope: StageScope): string {
  const query = new URLSearchParams({
    project: scope.project,
    stage: scope.stage,
  });

  return `?${query.toString()}`;
}
