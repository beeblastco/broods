/**
 * Account config-plane client for the broods public account REST API.
 *
 * This is the DYNAMIC counterpart to the config-first `broods dev` / `broods
 * deploy` flow: `broods dev` syncs the predefined resources declared in your
 * `broods/` folder, while `BroodsAccountClient` creates and mutates the full
 * account config plane at runtime — agents, sandboxes (config + lifecycle),
 * workspaces (config + files), tools, policies, skills, crons, and the account
 * itself — e.g. a multi-tenant app provisioning one agent per customer from its
 * own backend.
 *
 * Kept intentionally standalone (import from `broods/account`): pure fetch,
 * no Node built-ins, no `.env` file loading — so it runs in edge/worker
 * runtimes such as Convex actions, Cloudflare Workers, and the browser-less
 * server runtimes, as well as Node and Bun.
 *
 * Auth: every call sends `Authorization: Bearer {accountSecret}` to
 * `{baseUrl}/v1/...` — or a short-lived `fp_sts_` role session token from
 * `assumeRole()`, limited to what the role's policy allows. Secrets inside
 * agent configs are encrypted at rest by the platform and come back redacted
 * (`********`) on reads.
 */

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

/**
 * Managed gateway host, matching the OpenAPI `servers` entry and
 * `DEFAULT_CORE_BASE_URL` in `client.ts` (not imported from there — that module
 * pulls in Node-only .env loading and this one must stay edge-safe).
 */
const DEFAULT_ACCOUNT_BASE_URL = "https://gateway.broods.app";

export interface BroodsAccountClientOptions {
  /** Base URL of the broods gateway. Falls back to `BROODS_BASE_URL`, then `https://gateway.broods.app`. */
  baseUrl?: string;
  /** Account secret used as the Bearer token. Falls back to `BROODS_ACCOUNT_SECRET`. */
  accountSecret?: string;
  /**
   * Short-lived `fp_sts_` role session token (from {@link BroodsAccountClient.assumeRole})
   * used as the Bearer instead of the account secret. The session can only do
   * what its role's policy allows. Falls back to `BROODS_SESSION_TOKEN`.
   */
  sessionToken?: string;
  fetch?: typeof fetch;
}

/** Public account record returned by `GET /v1/account`. */
export interface BroodsAccount {
  accountId: string;
  username: string;
  status: string;
  [key: string]: unknown;
}

/** Public agent record; `config` comes back with secret values redacted. */
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

/** Write-only account environment variable metadata. */
export interface AccountEnvVar {
  name: string;
  updatedAt: number;
}

const ACCOUNT_ENV_VAR_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** Build a validated account env-var reference for use in an agent config. */
export function envPlaceholder(name: string): string {
  if (!ACCOUNT_ENV_VAR_NAME_PATTERN.test(name) || name.length > 64) {
    throw new Error(
      "envPlaceholder name must match /^[A-Z][A-Z0-9_]*$/ and be at most 64 characters.",
    );
  }

  return `\${${name}}`;
}

/** Fields accepted by `PATCH /v1/agents/{id}`. `config` is deep-merged; `null` values delete keys. */
export interface UpdateAgentInput {
  name?: string;
  description?: string | null;
  config?: unknown;
}

/** Public workspace record returned by the workspaces routes. */
export interface AccountWorkspace {
  accountId: string;
  workspaceId: string;
  name: string;
  description?: string;
  config: WorkspaceConfig;
  createdAt: string;
  updatedAt: string;
}

/** One entry of a workspace file listing (`GET /v1/workspaces/{id}/files`). */
export interface WorkspaceFileEntry {
  path: string;
  name: string;
  isFolder: boolean;
  sizeBytes?: number;
  updatedAt?: string;
}

/** Public sandbox config record; `config` comes back with secret values (e.g. `envVars`) redacted. */
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

/** Public agent-policy record returned by the policies routes. */
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

/**
 * Public account-role record returned by the roles routes. The policy uses the
 * API action namespace (`"agents:read"`, `"crons:write"`, ...); `projectId` and
 * `stageId` bound which stage runtime keys may assume the role.
 */
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

/** Short-lived role session minted by `POST /v1/account/assume-role`. */
export interface AssumeRoleResult {
  /** `fp_sts_` bearer token; pass it as `sessionToken` to a new client. */
  token: string;
  /** ISO timestamp when the session stops working. */
  expiresAt: string;
}

/**
 * One real place a team talks — a Slack channel, a Discord channel, a repo —
 * bound to an agent. The runtime reads it on the inbound webhook to decide who
 * answers there and with what instructions, workspaces and policies.
 */
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
  /** Added to whatever the agent already carries. Each policy holds its own mode. */
  policies?: string[];
  /**
   * Tool names withheld in this channel, applied after the tool set is built —
   * so it also covers sandbox tools (`bash`, `read`, …) that `config.tools`
   * cannot name. Narrowing only; unknown names are ignored.
   */
  denyTools?: string[];
  /**
   * Where the reply lands. `source` answers wherever the message came from, and
   * threads only when the message already did. Slack only — no other provider
   * gives the runtime a second place to reply.
   */
  replyIn?: ChannelReplyIn;
  partition?: ChannelPartition;
  /** Images the agent may stand a sandbox up from for a thread here. */
  sandboxImages?: string[];
  /** Named groups of people, readable from policy conditions as `userRoles`. */
  tagRoles?: Array<{ roleId: string; userIds: string[] }>;
}

/** The stage a resource belongs to. Same name in two stages = two resources. */
export interface StageScope {
  project: string;
  stage: string;
}

/** Public MCP server registration returned by the `/v1/mcp` routes (#331). */
export interface AccountMcp {
  accountId: string;
  serverId: string;
  projectId: string;
  stageId: string;
  name: string;
  description?: string;
  transport: "http" | "hosted";
  /** External servers only; a hosted row has no endpoint of its own. */
  url?: string;
  /** Hosted servers only: content hash of the uploaded bundle. */
  sha256?: string;
  headers?: Record<string, string>;
  allowedTools?: string[];
  disabled: boolean;
  status: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

/** Fields accepted by `POST /v1/mcp`: `url` connects, `bundle` uploads. */
export interface CreateMcpInput {
  name: string;
  description?: string;
  url?: string;
  bundle?: string;
  headers?: Record<string, string>;
  allowedTools?: string[];
}

/** Fields accepted by `PATCH /v1/mcp/{serverId}`; every field is optional. */
export interface UpdateMcpInput {
  name?: string;
  description?: string;
  url?: string;
  bundle?: string;
  headers?: Record<string, string>;
  allowedTools?: string[];
  disabled?: boolean;
}

/**
 * Body of a skill upload (`POST /v1/skills`, `PUT /v1/skills/{skillName}`).
 * `json` needs `name`/`description`/`content`; `files` needs base64 `files`
 * including a root `SKILL.md`; `github` needs a tree `url`.
 */
export interface SkillUploadInput {
  source: "json" | "files" | "github";
  name?: string;
  description?: string;
  content?: string;
  files?: Array<{ path: string; contentBase64: string; contentType?: string }>;
  url?: string;
}

/** Result of `POST /v1/account/rotate-secret`. The returned `secret` is shown once; the old secret stops working immediately. */
export interface RotateSecretResult {
  account: BroodsAccount;
  secret: string;
}

/** Result of `DELETE /v1/account`: the account and all account-scoped data are removed; `cleanup` reports per-resource deletion counts. */
export interface DeleteAccountResult {
  deleted: boolean;
  cleanup?: Record<string, number>;
}

/** Result of a suspend/resume/terminate sandbox lifecycle action. */
export interface SandboxLifecycleResult {
  status: string;
}

/** Result of `POST /v1/sandboxes/{id}/snapshot`. */
export interface SandboxSnapshotResult {
  status: string;
  snapshotId?: string;
  externalImageId?: string;
}

/** Sealed ticket from `POST /v1/sandboxes/{id}/terminal`; hand `token` to the gateway terminal WebSocket at `websocketPath`. */
export interface SandboxTerminalTicket {
  token: string;
  expiresAt: number;
  websocketPath: string;
}

/** Non-2xx response from the account API (404s on id routes return null instead). */
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

/**
 * The credential the environment supplies, with a role session winning over
 * the account secret. The constructor throws through this same resolution, so
 * callers that can run without an account credential (`broods mcp` with only a
 * stored login) probe here instead of catching the constructor.
 */
export function resolveEnvCredential(): string | undefined {
  return envVar("BROODS_SESSION_TOKEN") ?? envVar("BROODS_ACCOUNT_SECRET");
}

function envVar(name: string): string | undefined {
  return typeof process !== "undefined" ? process?.env?.[name] : undefined;
}

function stageScopeQuery(scope: StageScope): string {
  const query = new URLSearchParams({
    project: scope.project,
    stage: scope.stage,
  });

  return `?${query.toString()}`;
}

/**
 * Typed client for the broods account config API. All `get`/`update`/`delete`
 * methods return `null`/`false` when the resource does not exist (HTTP 404) so
 * callers can implement upsert flows without try/catch; every other non-2xx
 * status throws {@link BroodsAccountApiError}.
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

  /** The account this secret belongs to. Its `accountId` is the first segment of channel webhook URLs. */
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

  /** Update account metadata (username/description). Returns null when the account is gone. Runtime config is managed through the agent endpoints. */
  async updateAccount(patch: {
    username?: string;
    description?: string | null;
  }): Promise<BroodsAccount | null> {
    const result = await this.request<{ account: BroodsAccount }>(
      "PATCH",
      "/v1/account",
      patch,
    );

    return result?.account ?? null;
  }

  /**
   * Exchange a role for a short-lived `fp_sts_` session token. Callable with
   * the account secret, a CLI login token, or a stage runtime key (the latter
   * only into roles scoped to the key's own project/stage). Construct a new
   * client with `{ sessionToken: result.token }` to act as the role.
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

  /** Rotate the account secret. The returned `secret` is shown once and the current secret stops working immediately, so persist it before the process exits. */
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

  /** Delete this account and cascade-clean every account-scoped resource. `cleanup` reports per-resource deletion counts. */
  async deleteAccount(): Promise<DeleteAccountResult> {
    const result = await this.request<DeleteAccountResult>(
      "DELETE",
      "/v1/account",
    );

    return result ?? { deleted: false };
  }

  /**
   * Provider webhook URL for one of the account's channels. Paste this into the
   * provider's webhook settings (Slack Event Subscriptions, Zalo OA webhook,
   * Pancake page webhook). Routing is per account + channel: the credentials
   * that verify the request pick the receiving agent, and a channel record
   * binds each place to the agent that should answer there.
   */
  webhookUrl(accountId: string, channelType: string): string {
    const segments = [accountId, channelType].map(encodeURIComponent);

    return `${this.baseUrl}/webhooks/${segments.join("/")}`;
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
    config: unknown;
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

  /** PATCH an agent. `config` deep-merges into the stored config; `null` leaves delete keys. Returns null when the agent is gone. */
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

  /** List account environment variable names and update timestamps; values are never returned. */
  async listEnvVars(): Promise<AccountEnvVar[]> {
    const result = await this.request<{ env: AccountEnvVar[] }>(
      "GET",
      "/v1/env",
    );

    return result?.env ?? [];
  }

  /** Create or replace one write-only account environment variable. */
  async setEnvVar(name: string, value: string): Promise<void> {
    await this.request<{ name: string }>(
      "PUT",
      `/v1/env/${encodeURIComponent(name)}`,
      { value: value },
    );
  }

  /** Delete one account environment variable. Returns false when it is already absent. */
  async deleteEnvVar(name: string): Promise<boolean> {
    const result = await this.request<{ deleted: boolean }>(
      "DELETE",
      `/v1/env/${encodeURIComponent(name)}`,
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

  /** Run history for a cron, newest first. Returns [] when the cron is gone. */
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
    config?: unknown;
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
    patch: { name?: string; description?: string | null; config?: unknown },
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

  /** Flat listing of every file in the workspace's S3-backed filesystem. Returns [] when the workspace is gone. */
  async listWorkspaceFiles(workspaceId: string): Promise<WorkspaceFileEntry[]> {
    const result = await this.request<{ files: WorkspaceFileEntry[] }>(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/files`,
    );

    return result?.files ?? [];
  }

  /** Short-lived download URL for one workspace file. Returns null when the workspace or file is gone. */
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

  /** Upload or replace one workspace file from base64 content. Throws when the workspace is gone (404). */
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

  /** Rename a workspace file or folder. Returns false when the workspace or source path is gone. */
  async renameWorkspaceFile(
    workspaceId: string,
    path: string,
    newPath: string,
  ): Promise<boolean> {
    const result = await this.request<{ renamed: boolean }>(
      "PATCH",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/files`,
      { path: path, newPath: newPath },
    );

    return result?.renamed ?? false;
  }

  /** Delete a workspace file or folder. Returns false when the workspace or path is gone. */
  async deleteWorkspaceFile(
    workspaceId: string,
    path: string,
  ): Promise<boolean> {
    const result = await this.request<{ deleted: boolean }>(
      "DELETE",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/files`,
      { path: path },
    );

    return result?.deleted ?? false;
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
    config?: unknown;
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

  /** PATCH a sandbox config. `config` fully replaces the stored config. Returns null when the sandbox is gone. */
  async updateSandbox(
    sandboxId: string,
    patch: { name?: string; description?: string | null; config?: unknown },
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

  /** Suspend a persistent sandbox reservation. Throws on 404/403/409 (missing sandbox, foreign reservation, or unsupported provider). */
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

  /** Resume a persistent sandbox reservation. Throws on 404/403/409. */
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

  /** Terminate a persistent sandbox reservation and drop its live-instance row. Throws on 404/403/409. */
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

  /** Snapshot a persistent sandbox reservation into a reusable image (self-hosted `sandbox` provider). Throws on 404/403/409. */
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

  /** Mint a short-lived sealed ticket for an interactive PTY session on a persistent sandbox (`sandbox`/`lambda` providers). Throws on 404/403/409. */
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

  /** MCP servers live in one stage, so the collection routes need a scope. */
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

  /** PATCH a policy. `description: null` clears it. Returns null when the policy is gone. */
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

  /** Roles are account-secret only: a session cannot list, mint, or edit roles. */
  async listRoles(): Promise<AccountRole[]> {
    const result = await this.request<{ roles: AccountRole[] }>(
      "GET",
      "/v1/roles",
    );

    return result?.roles ?? [];
  }

  /** Create a role whose policy uses the API action namespace. `projectId`/`stageId` must be provided together. */
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

  /** PATCH a role. `status: "disabled"` kills every live session of the role. Returns null when the role is gone. */
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

  async listChannels(): Promise<AccountChannel[]> {
    const result = await this.request<{ channels: AccountChannel[] }>(
      "GET",
      "/v1/channels",
    );

    return result?.channels ?? [];
  }

  /** Bind one real chat channel to an agent. One active record per place. */
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

  /** PATCH a channel. `description: null` clears it. Returns null when it is gone. */
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

  /** All skills for the account, each with its `<accountId>/<name>` path. */
  async listSkills(): Promise<Skill[]> {
    const result = await this.request<{ skills: Skill[] }>("GET", "/v1/skills");

    return result?.skills ?? [];
  }

  /** Upload a new skill from JSON content, a base64 file bundle, or a GitHub tree URL. Every bundle must include a root `SKILL.md`. */
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

  /** Replace a skill's bundle in place (`PUT`). Throws when the skill is gone (404). */
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

  /** POST a sandbox lifecycle action, throwing on any non-2xx (including 404, since these are not upsert flows). */
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
