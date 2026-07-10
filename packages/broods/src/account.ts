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
 * `{baseUrl}/v1/...`. Secrets inside agent configs are encrypted at rest by
 * the platform and come back redacted (`********`) on reads.
 */

import type {
  AgentConfig,
  AgentPolicyDocument,
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
  document: AgentPolicyDocument;
  status: string;
  createdAt: string;
  updatedAt: string;
}

/** Public uploaded-tool record returned by the tools routes. */
export interface AccountTool {
  accountId: string;
  toolId: string;
  name: string;
  description: string;
  inputSchema: unknown;
  sha256: string;
  runtime: "isolate" | "sandbox";
  defaultConfig?: unknown;
  status: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

/** Fields accepted by `POST /v1/tools`. `bundle` is already-bundled JavaScript module source. */
export interface CreateToolInput {
  name: string;
  description: string;
  inputSchema: unknown;
  bundle: string;
  runtime?: "isolate" | "sandbox";
  defaultConfig?: unknown;
}

/** Fields accepted by `PATCH /v1/tools/{toolId}`; every field is optional. Omitting `bundle` keeps the stored one. */
export interface UpdateToolInput {
  name?: string;
  description?: string;
  inputSchema?: unknown;
  bundle?: string;
  runtime?: "isolate" | "sandbox";
  defaultConfig?: unknown;
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

function envVar(name: string): string | undefined {
  return typeof process !== "undefined" ? process?.env?.[name] : undefined;
}

/**
 * Typed client for the broods account config API. All `get`/`update`/`delete`
 * methods return `null`/`false` when the resource does not exist (HTTP 404) so
 * callers can implement upsert flows without try/catch; every other non-2xx
 * status throws {@link BroodsAccountApiError}.
 */
export class BroodsAccountClient {
  private readonly baseUrl: string;
  private readonly accountSecret: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BroodsAccountClientOptions = {}) {
    const baseUrl = options.baseUrl ?? envVar("BROODS_BASE_URL") ?? DEFAULT_ACCOUNT_BASE_URL;
    const accountSecret = options.accountSecret ?? envVar("BROODS_ACCOUNT_SECRET");
    if (!accountSecret) throw new Error("BroodsAccountClient requires an accountSecret (or BROODS_ACCOUNT_SECRET).");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.accountSecret = accountSecret;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** The account this secret belongs to. Its `accountId` is the first segment of channel webhook URLs. */
  async getAccount(): Promise<BroodsAccount> {
    const result = await this.request<{ account: BroodsAccount }>("GET", "/v1/account");
    if (!result) throw new BroodsAccountApiError("GET", "/v1/account", 404, "Account not found");
    return result.account;
  }

  /** Update account metadata (username/description). Returns null when the account is gone. Runtime config is managed through the agent endpoints. */
  async updateAccount(patch: { username?: string; description?: string | null }): Promise<BroodsAccount | null> {
    const result = await this.request<{ account: BroodsAccount }>("PATCH", "/v1/account", patch);
    return result?.account ?? null;
  }

  /** Rotate the account secret. The returned `secret` is shown once and the current secret stops working immediately, so persist it before the process exits. */
  async rotateSecret(): Promise<RotateSecretResult> {
    const result = await this.request<RotateSecretResult>("POST", "/v1/account/rotate-secret");
    if (!result) throw new BroodsAccountApiError("POST", "/v1/account/rotate-secret", 404, "Account not found");
    return result;
  }

  /** Delete this account and cascade-clean every account-scoped resource. `cleanup` reports per-resource deletion counts. */
  async deleteAccount(): Promise<DeleteAccountResult> {
    const result = await this.request<DeleteAccountResult>("DELETE", "/v1/account");
    return result ?? { deleted: false };
  }

  /**
   * Provider webhook URL for one of an agent's channels. Paste this into the
   * provider's webhook settings (Slack Event Subscriptions, Zalo OA webhook,
   * Pancake page webhook). Routing is per account + agent, so each agent's
   * channels are isolated from every other agent's.
   */
  webhookUrl(accountId: string, agentId: string, channelType: string): string {
    const segments = [accountId, agentId, channelType].map(encodeURIComponent);
    return `${this.baseUrl}/webhooks/${segments.join("/")}`;
  }

  async listAgents(): Promise<AccountAgent[]> {
    const result = await this.request<{ agents: AccountAgent[] }>("GET", "/v1/agents");
    return result?.agents ?? [];
  }

  async createAgent(input: { name: string; description?: string; config: unknown }): Promise<CreateAgentResult> {
    const result = await this.request<CreateAgentResult>("POST", "/v1/agents", input);
    if (!result) throw new BroodsAccountApiError("POST", "/v1/agents", 404, "Not found");
    return result;
  }

  async getAgent(agentId: string): Promise<AccountAgent | null> {
    return await this.request<AccountAgent>("GET", `/v1/agents/${encodeURIComponent(agentId)}`);
  }

  /** PATCH an agent. `config` deep-merges into the stored config; `null` leaves delete keys. Returns null when the agent is gone. */
  async updateAgent(agentId: string, patch: UpdateAgentInput): Promise<AccountAgent | null> {
    return await this.request<AccountAgent>("PATCH", `/v1/agents/${encodeURIComponent(agentId)}`, patch);
  }

  async deleteAgent(agentId: string): Promise<boolean> {
    const result = await this.request<{ deleted: boolean }>("DELETE", `/v1/agents/${encodeURIComponent(agentId)}`);
    return result?.deleted ?? false;
  }

  async listCrons(): Promise<Cron[]> {
    const result = await this.request<{ crons: Cron[] }>("GET", "/v1/crons");
    return result?.crons ?? [];
  }

  async createCron(input: CreateCronInput): Promise<Cron> {
    const result = await this.request<Cron>("POST", "/v1/crons", input);
    if (!result) throw new BroodsAccountApiError("POST", "/v1/crons", 404, "Not found");
    return result;
  }

  async getCron(cronId: string): Promise<Cron | null> {
    return await this.request<Cron>("GET", `/v1/crons/${encodeURIComponent(cronId)}`);
  }

  async updateCron(cronId: string, patch: UpdateCronInput): Promise<Cron | null> {
    return await this.request<Cron>("PATCH", `/v1/crons/${encodeURIComponent(cronId)}`, patch);
  }

  async deleteCron(cronId: string): Promise<boolean> {
    const result = await this.request<{ deleted: boolean }>("DELETE", `/v1/crons/${encodeURIComponent(cronId)}`);
    return result?.deleted ?? false;
  }

  /** Run history for a cron, newest first. Returns [] when the cron is gone. */
  async listCronRuns(cronId: string, options: { limit?: number } = {}): Promise<CronRun[]> {
    const query = options.limit !== undefined ? `?limit=${options.limit}` : "";
    const result = await this.request<{ runs: CronRun[] }>(
      "GET",
      `/v1/crons/${encodeURIComponent(cronId)}/runs${query}`,
    );
    return result?.runs ?? [];
  }

  async listWorkspaces(): Promise<AccountWorkspace[]> {
    const result = await this.request<{ workspaces: AccountWorkspace[] }>("GET", "/v1/workspaces");
    return result?.workspaces ?? [];
  }

  async createWorkspace(input: { name: string; description?: string; config?: unknown }): Promise<AccountWorkspace> {
    const result = await this.request<AccountWorkspace>("POST", "/v1/workspaces", input);
    if (!result) throw new BroodsAccountApiError("POST", "/v1/workspaces", 404, "Not found");
    return result;
  }

  async getWorkspace(workspaceId: string): Promise<AccountWorkspace | null> {
    return await this.request<AccountWorkspace>("GET", `/v1/workspaces/${encodeURIComponent(workspaceId)}`);
  }

  async updateWorkspace(
    workspaceId: string,
    patch: { name?: string; description?: string | null; config?: unknown },
  ): Promise<AccountWorkspace | null> {
    return await this.request<AccountWorkspace>("PATCH", `/v1/workspaces/${encodeURIComponent(workspaceId)}`, patch);
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
  async getWorkspaceFileUrl(workspaceId: string, path: string): Promise<string | null> {
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
    const result = await this.request<{ file: WorkspaceFileEntry }>("POST", path, input);
    if (!result) throw new BroodsAccountApiError("POST", path, 404, "Workspace not found");
    return result.file;
  }

  /** Rename a workspace file or folder. Returns false when the workspace or source path is gone. */
  async renameWorkspaceFile(workspaceId: string, path: string, newPath: string): Promise<boolean> {
    const result = await this.request<{ renamed: boolean }>(
      "PATCH",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/files`,
      { path, newPath },
    );
    return result?.renamed ?? false;
  }

  /** Delete a workspace file or folder. Returns false when the workspace or path is gone. */
  async deleteWorkspaceFile(workspaceId: string, path: string): Promise<boolean> {
    const result = await this.request<{ deleted: boolean }>(
      "DELETE",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/files`,
      { path },
    );
    return result?.deleted ?? false;
  }

  async listSandboxes(): Promise<AccountSandbox[]> {
    const result = await this.request<{ sandboxes: AccountSandbox[] }>("GET", "/v1/sandboxes");
    return result?.sandboxes ?? [];
  }

  async createSandbox(input: { name: string; description?: string; config?: unknown }): Promise<AccountSandbox> {
    const result = await this.request<AccountSandbox>("POST", "/v1/sandboxes", input);
    if (!result) throw new BroodsAccountApiError("POST", "/v1/sandboxes", 404, "Not found");
    return result;
  }

  async getSandbox(sandboxId: string): Promise<AccountSandbox | null> {
    return await this.request<AccountSandbox>("GET", `/v1/sandboxes/${encodeURIComponent(sandboxId)}`);
  }

  /** PATCH a sandbox config. `config` fully replaces the stored config. Returns null when the sandbox is gone. */
  async updateSandbox(
    sandboxId: string,
    patch: { name?: string; description?: string | null; config?: unknown },
  ): Promise<AccountSandbox | null> {
    return await this.request<AccountSandbox>("PATCH", `/v1/sandboxes/${encodeURIComponent(sandboxId)}`, patch);
  }

  async deleteSandbox(sandboxId: string): Promise<boolean> {
    const result = await this.request<{ deleted: boolean }>("DELETE", `/v1/sandboxes/${encodeURIComponent(sandboxId)}`);
    return result?.deleted ?? false;
  }

  /** Suspend a persistent sandbox reservation. Throws on 404/403/409 (missing sandbox, foreign reservation, or unsupported provider). */
  async suspendSandbox(sandboxId: string, reservationKey: string): Promise<SandboxLifecycleResult> {
    return await this.sandboxAction<SandboxLifecycleResult>(sandboxId, "suspend", { reservationKey });
  }

  /** Resume a persistent sandbox reservation. Throws on 404/403/409. */
  async resumeSandbox(sandboxId: string, reservationKey: string): Promise<SandboxLifecycleResult> {
    return await this.sandboxAction<SandboxLifecycleResult>(sandboxId, "resume", { reservationKey });
  }

  /** Terminate a persistent sandbox reservation and drop its live-instance row. Throws on 404/403/409. */
  async terminateSandbox(sandboxId: string, reservationKey: string): Promise<SandboxLifecycleResult> {
    return await this.sandboxAction<SandboxLifecycleResult>(sandboxId, "terminate", { reservationKey });
  }

  /** Snapshot a persistent sandbox reservation into a reusable image (self-hosted `sandbox` provider). Throws on 404/403/409. */
  async snapshotSandbox(sandboxId: string, reservationKey: string, name: string): Promise<SandboxSnapshotResult> {
    return await this.sandboxAction<SandboxSnapshotResult>(sandboxId, "snapshot", { reservationKey, name });
  }

  /** Mint a short-lived sealed ticket for an interactive PTY session on a persistent sandbox (`sandbox`/`lambda` providers). Throws on 404/403/409. */
  async openSandboxTerminal(sandboxId: string, reservationKey: string): Promise<SandboxTerminalTicket> {
    return await this.sandboxAction<SandboxTerminalTicket>(sandboxId, "terminal", { reservationKey });
  }

  async listTools(): Promise<AccountTool[]> {
    const result = await this.request<{ tools: AccountTool[] }>("GET", "/v1/tools");
    return result?.tools ?? [];
  }

  async createTool(input: CreateToolInput): Promise<AccountTool> {
    const result = await this.request<AccountTool>("POST", "/v1/tools", input);
    if (!result) throw new BroodsAccountApiError("POST", "/v1/tools", 404, "Not found");
    return result;
  }

  async getTool(toolId: string): Promise<AccountTool | null> {
    return await this.request<AccountTool>("GET", `/v1/tools/${encodeURIComponent(toolId)}`);
  }

  /** PATCH an uploaded tool. Omitting `bundle` keeps the stored bundle and runtime. Returns null when the tool is gone. */
  async updateTool(toolId: string, patch: UpdateToolInput): Promise<AccountTool | null> {
    return await this.request<AccountTool>("PATCH", `/v1/tools/${encodeURIComponent(toolId)}`, patch);
  }

  async deleteTool(toolId: string): Promise<boolean> {
    const result = await this.request<{ deleted: boolean }>("DELETE", `/v1/tools/${encodeURIComponent(toolId)}`);
    return result?.deleted ?? false;
  }

  async listPolicies(): Promise<AccountPolicy[]> {
    const result = await this.request<{ policies: AccountPolicy[] }>("GET", "/v1/policies");
    return result?.policies ?? [];
  }

  async createPolicy(input: { name: string; description?: string; document: AgentPolicyDocument }): Promise<AccountPolicy> {
    const result = await this.request<AccountPolicy>("POST", "/v1/policies", input);
    if (!result) throw new BroodsAccountApiError("POST", "/v1/policies", 404, "Not found");
    return result;
  }

  async getPolicy(policyId: string): Promise<AccountPolicy | null> {
    return await this.request<AccountPolicy>("GET", `/v1/policies/${encodeURIComponent(policyId)}`);
  }

  /** PATCH a policy. `description: null` clears it. Returns null when the policy is gone. */
  async updatePolicy(
    policyId: string,
    patch: { name?: string; description?: string | null; document?: AgentPolicyDocument; status?: string },
  ): Promise<AccountPolicy | null> {
    return await this.request<AccountPolicy>("PATCH", `/v1/policies/${encodeURIComponent(policyId)}`, patch);
  }

  async deletePolicy(policyId: string): Promise<boolean> {
    const result = await this.request<{ deleted: boolean }>("DELETE", `/v1/policies/${encodeURIComponent(policyId)}`);
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
    if (!result) throw new BroodsAccountApiError("POST", "/v1/skills", 404, "Not found");
    return result;
  }

  async getSkill(skillName: string): Promise<Skill | null> {
    return await this.request<Skill>("GET", `/v1/skills/${encodeURIComponent(skillName)}`);
  }

  /** Replace a skill's bundle in place (`PUT`). Throws when the skill is gone (404). */
  async uploadSkill(skillName: string, input: SkillUploadInput): Promise<Skill> {
    const path = `/v1/skills/${encodeURIComponent(skillName)}`;
    const result = await this.request<Skill>("PUT", path, input);
    if (!result) throw new BroodsAccountApiError("PUT", path, 404, "Skill not found");
    return result;
  }

  async deleteSkill(skillName: string): Promise<boolean> {
    const result = await this.request<{ deleted: boolean }>("DELETE", `/v1/skills/${encodeURIComponent(skillName)}`);
    return result?.deleted ?? false;
  }

  /** POST a sandbox lifecycle action, throwing on any non-2xx (including 404, since these are not upsert flows). */
  private async sandboxAction<T>(sandboxId: string, action: string, body: unknown): Promise<T> {
    const path = `/v1/sandboxes/${encodeURIComponent(sandboxId)}/${action}`;
    const result = await this.request<T>("POST", path, body);
    if (!result) throw new BroodsAccountApiError("POST", path, 404, "Sandbox not found");
    return result;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.accountSecret}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new BroodsAccountApiError(method, path, response.status, await response.text());
    }
    return (await response.json()) as T;
  }
}
