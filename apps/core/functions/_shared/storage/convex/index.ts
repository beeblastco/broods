/**
 * Convex-backed StorageProvider. Used when STORAGE_PROVIDER=convex
 * (SaaS deployment). All calls go through ConvexHttpClient with a
 * deploy-key admin auth header.
 *
 * Read paths (the auth path + harness reads) are fully implemented.
 * Account-create / rotate-secret are owned by the cherry-coke side
 * (orgLifecycle) and intentionally throw here — broods does not
 * create accounts in SaaS mode. Agent + cron writes are wired so
 * the harness can persist normally.
 */

import {
  encryptAgentConfig,
  decodeStoredAgentConfig,
  encryptConfigObject,
  decodeStoredConfigObject,
} from "../agent-config.ts";
import {
  normalizeCreateAgentInput,
  normalizeUpdateAgentInput,
} from "../agents.ts";
import {
  normalizeCreateCronInput,
  normalizeSchedulerGroupName,
  normalizeUpdateCronInput,
} from "../cron.ts";
import type { ModelMessage } from "ai";
import {
  normalizeCreateSandboxConfigInput,
  normalizeUpdateSandboxConfigInput,
  type SandboxConfig,
} from "../sandbox-config.ts";
import {
  normalizeCreateWorkspaceConfigInput,
  normalizeUpdateWorkspaceConfigInput,
  type WorkspaceConfig,
} from "../workspace-config.ts";
import {
  normalizeCreateAccountToolInput,
  normalizeUpdateAccountToolInput,
  type AccountToolRecord,
} from "../account-tools.ts";
import { usage } from "./usage.ts";

// ConvexHttpClient's typed `query`/`mutation` only accept public function
// refs; the backend package exposes internalQuery / internalMutation, so we
// cast at the boundary. Deploy-key auth permits calling these at runtime.
// require() (not import) keeps the backend's generated types out of this
// package's typecheck program — its sources are checked by their own
// tsconfig — while Bun still resolves and bundles the module statically.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const internal: any = require("@broods/convex/_generated/api").internal;
import type {
  AccountRecord,
  AgentDeploymentRecord,
  AgentDeploymentStore,
  AgentRecord,
  AccountStore,
  AccountToolStore,
  AgentStore,
  CronRecord,
  CronRunRecord,
  CronStore,
  SandboxConfigRecord,
  SandboxConfigStore,
  StorageProvider,
  WorkspaceConfigRecord,
  WorkspaceConfigStore,
} from "../types.ts";
import { getConvexClient } from "./client.ts";

const NOT_SUPPORTED_IN_CONVEX_MODE =
  "Operation not supported in convex storage mode — drive via cherry-coke orgLifecycle";

interface ConvexAccountDoc {
  _id: string;
  orgId: string;
  username: string;
  description?: string;
  secretHash: string;
  status: "active" | "disabled";
  createdAt: number;
  updatedAt: number;
}

function accountFromConvex(doc: ConvexAccountDoc | null): AccountRecord | null {
  if (!doc) return null;
  return {
    accountId: doc._id,
    username: doc.username,
    ...(doc.description ? { description: doc.description } : {}),
    secretHash: doc.secretHash,
    status: doc.status,
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
  };
}

interface ConvexAgentDoc {
  _id: string;
  accountId: string;
  name: string;
  description?: string;
  encryptedConfig?: string;
  encryptionIv?: string;
  encryptionTag?: string;
  createdAt: number;
  updatedAt: number;
}

function agentFromConvex(doc: ConvexAgentDoc | null): AgentRecord | null {
  if (!doc) return null;
  const config = doc.encryptedConfig && doc.encryptionIv && doc.encryptionTag
    ? decodeStoredAgentConfig({
        encrypted: true as const,
        algorithm: "aes-256-gcm",
        ciphertext: doc.encryptedConfig,
        iv: doc.encryptionIv,
        tag: doc.encryptionTag,
      })
    : {};
  return {
    accountId: doc.accountId,
    agentId: doc._id,
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    status: "active",
    config,
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
  };
}

interface ConvexCronDoc {
  _id: string;
  accountId: string;
  name: string;
  description?: string;
  agentId: string;
  events: ModelMessage[];
  conversationKey?: string;
  scheduleExpression: string;
  timezone?: string;
  status: "active" | "paused";
  schedulerName: string;
  schedulerGroupName: string;
  createdAt: number;
  updatedAt: number;
  lastInvokedAt?: number;
  lastStatus?: "started" | "completed" | "failed";
  lastError?: string;
}

interface ConvexCronRunDoc {
  _id: string;
  accountId: string;
  cronId: string;
  eventId: string;
  conversationKey: string;
  status: "started" | "completed" | "failed";
  result?: unknown;
  error?: string;
  startedAt: number;
  completedAt?: number;
}

function cronFromConvex(doc: ConvexCronDoc | null): CronRecord | null {
  if (!doc) return null;
  return {
    accountId: doc.accountId,
    cronId: doc._id,
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    agentId: doc.agentId,
    events: doc.events,
    ...(doc.conversationKey ? { conversationKey: doc.conversationKey } : {}),
    scheduleExpression: doc.scheduleExpression,
    ...(doc.timezone ? { timezone: doc.timezone } : {}),
    status: doc.status,
    schedulerName: doc.schedulerName,
    schedulerGroupName: doc.schedulerGroupName,
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
    ...(doc.lastInvokedAt ? { lastInvokedAt: new Date(doc.lastInvokedAt).toISOString() } : {}),
    ...(doc.lastStatus ? { lastStatus: doc.lastStatus } : {}),
    ...(doc.lastError ? { lastError: doc.lastError } : {}),
  };
}

function cronRunFromConvex(doc: ConvexCronRunDoc | null): CronRunRecord | null {
  if (!doc) return null;
  return {
    accountId: doc.accountId,
    cronId: doc.cronId,
    runId: doc._id,
    eventId: doc.eventId,
    conversationKey: doc.conversationKey,
    status: doc.status,
    ...(doc.result !== undefined ? { result: doc.result } : {}),
    ...(doc.error ? { error: doc.error } : {}),
    startedAt: new Date(doc.startedAt).toISOString(),
    ...(doc.completedAt ? { completedAt: new Date(doc.completedAt).toISOString() } : {}),
  };
}

const accounts: AccountStore = {
  async getById(accountId) {
    const doc = await getConvexClient().query(internal.accounts.getById, {
      accountId: accountId as any,
    });
    return accountFromConvex(doc as ConvexAccountDoc | null);
  },
  async getBySecretHash(secretHash) {
    const doc = await getConvexClient().query(internal.accounts.getBySecretHash, {
      secretHash,
    });
    return accountFromConvex(doc as ConvexAccountDoc | null);
  },
  async getByOrgId(orgId) {
    const doc = await getConvexClient().query(internal.accounts.getByOrgId, { orgId });
    return accountFromConvex(doc as ConvexAccountDoc | null);
  },
  async list() {
    const docs = (await getConvexClient().query(internal.accounts.list, {})) as ConvexAccountDoc[];
    return docs.map((d) => accountFromConvex(d)!).filter(Boolean);
  },
  async create() {
    throw new Error(NOT_SUPPORTED_IN_CONVEX_MODE);
  },
  async update() {
    throw new Error(NOT_SUPPORTED_IN_CONVEX_MODE);
  },
  async rotateSecret() {
    throw new Error(NOT_SUPPORTED_IN_CONVEX_MODE);
  },
  async remove() {
    throw new Error(NOT_SUPPORTED_IN_CONVEX_MODE);
  },
};

const agents: AgentStore = {
  async getById(accountId, agentId) {
    const doc = await getConvexClient().query(internal.agents.getById, {
      accountId: accountId as any,
      agentId: agentId as any,
    });
    return agentFromConvex(doc as ConvexAgentDoc | null);
  },
  async list(accountId) {
    const docs = (await getConvexClient().query(internal.agents.list, {
      accountId: accountId as any,
    })) as ConvexAgentDoc[];
    return docs.map((d) => agentFromConvex(d)!).filter(Boolean);
  },
  async create(accountId, input) {
    const normalized = await normalizeCreateAgentInput(accountId, input);
    const encrypted = encryptAgentConfig(normalized.config);
    const id = (await getConvexClient().mutation(internal.agents.create, {
      accountId: accountId as any,
      name: normalized.name,
      description: normalized.description,
      encryptedConfig: encrypted.ciphertext,
      encryptionIv: encrypted.iv,
      encryptionTag: encrypted.tag,
    })) as string;
    const created = await this.getById(accountId, id);
    if (!created) throw new Error("Failed to fetch created agent");
    return created;
  },
  async update(accountId, agentId, rawPatch) {
    const existing = await this.getById(accountId, agentId);
    if (!existing) return null;
    const patch = await normalizeUpdateAgentInput(accountId, existing.config, rawPatch);
    const encrypted = encryptAgentConfig(patch.config);
    const args: Record<string, unknown> = {
      accountId: accountId as any,
      agentId: agentId as any,
      encryptedConfig: encrypted.ciphertext,
      encryptionIv: encrypted.iv,
      encryptionTag: encrypted.tag,
    };
    if (patch.name !== undefined) args.name = patch.name;
    if (patch.description !== undefined) args.description = patch.description ?? undefined;
    await getConvexClient().mutation(internal.agents.update, args as any);
    return this.getById(accountId, agentId);
  },
  async remove(accountId, agentId) {
    await getConvexClient().mutation(internal.agents.remove, {
      accountId: accountId as any,
      agentId: agentId as any,
    });
    return true;
  },
  async removeAllForAccount(accountId) {
    const list = await this.list(accountId);
    for (const a of list) {
      await this.remove(accountId, a.agentId);
    }
    return list.length;
  },
};

const agentDeployments: AgentDeploymentStore = {
  async getByApiKeyHash(apiKeyHash) {
    const doc = await getConvexClient().query(internal.agentDeployments.getByApiKeyHash, {
      apiKeyHash: apiKeyHash,
    }) as AgentDeploymentRecord | null;
    return doc;
  },
  async getByAgentId(accountId, agentId) {
    const doc = await getConvexClient().query(internal.agentDeployments.getByAgentId, {
      accountId: accountId as any,
      agentId: agentId,
    }) as AgentDeploymentRecord | null;
    return doc;
  },
};

const crons: CronStore = {
  async getById(accountId, cronId) {
    const doc = await getConvexClient().query(internal.cron.getById, {
      accountId: accountId as any,
      cronId: cronId as any,
    });
    return cronFromConvex(doc as ConvexCronDoc | null);
  },
  async list(accountId) {
    const docs = (await getConvexClient().query(internal.cron.list, {
      accountId: accountId as any,
    })) as ConvexCronDoc[];
    return docs.map((d) => cronFromConvex(d)!).filter(Boolean);
  },
  async create(accountId, input, options) {
    const normalized = normalizeCreateCronInput(input);
    const schedulerGroupName = normalizeSchedulerGroupName(options.schedulerGroupName);
    const schedulerName = `${accountId}-${cryptoRandomId()}`;
    const id = (await getConvexClient().mutation(internal.cron.create, {
      accountId: accountId as any,
      name: normalized.name,
      description: normalized.description,
      agentId: normalized.agentId as any,
      events: normalized.events,
      conversationKey: normalized.conversationKey,
      scheduleExpression: normalized.scheduleExpression,
      timezone: normalized.timezone,
      status: normalized.status,
      schedulerName,
      schedulerGroupName,
    })) as string;
    const created = await this.getById(accountId, id);
    if (!created) throw new Error("Failed to fetch created cron job");
    return created;
  },
  async update(accountId, cronId, rawPatch) {
    const patch = normalizeUpdateCronInput(rawPatch);
    await getConvexClient().mutation(internal.cron.update, {
      accountId: accountId as any,
      cronId: cronId as any,
      name: patch.name,
      description: patch.description,
      agentId: patch.agentId as any,
      events: patch.events,
      conversationKey: patch.conversationKey,
      scheduleExpression: patch.scheduleExpression,
      timezone: patch.timezone,
      status: patch.status,
    });
    return this.getById(accountId, cronId);
  },
  async remove(accountId, cronId) {
    await getConvexClient().mutation(internal.cron.remove, {
      accountId: accountId as any,
      cronId: cronId as any,
    });
    return true;
  },
  async markStarted(accountId, cronId) {
    await getConvexClient().mutation(internal.cron.recordInvocation, {
      accountId: accountId as any,
      cronId: cronId as any,
      lastStatus: "started",
    });
  },
  async markCompleted(accountId, cronId) {
    await getConvexClient().mutation(internal.cron.recordInvocation, {
      accountId: accountId as any,
      cronId: cronId as any,
      lastStatus: "completed",
    });
  },
  async markFailed(accountId, cronId, error) {
    await getConvexClient().mutation(internal.cron.recordInvocation, {
      accountId: accountId as any,
      cronId: cronId as any,
      lastStatus: "failed",
      lastError: error,
    });
  },
  async createRun(input) {
    const runId = await getConvexClient().mutation(internal.cron.createRun, {
      accountId: input.accountId as any,
      cronId: input.cronId as any,
      eventId: input.eventId,
      conversationKey: input.conversationKey,
    }) as string;
    return {
      ...input,
      runId,
      status: "started",
      startedAt: new Date().toISOString(),
    };
  },
  async completeRun(accountId, cronId, runId, result) {
    await getConvexClient().mutation(internal.cron.completeRun, {
      accountId: accountId as any,
      cronId: cronId as any,
      runId: runId as any,
      result,
    });
  },
  async failRun(accountId, cronId, runId, error) {
    await getConvexClient().mutation(internal.cron.failRun, {
      accountId: accountId as any,
      cronId: cronId as any,
      runId: runId as any,
      error,
    });
  },
  async listRuns(accountId, cronId, limit) {
    const docs = await getConvexClient().query(internal.cron.listRuns, {
      accountId: accountId as any,
      cronId: cronId as any,
      limit,
    }) as ConvexCronRunDoc[];
    return docs.map((d) => cronRunFromConvex(d)!).filter(Boolean);
  },
};

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2, 14);
}

interface ConvexSandboxConfigDoc {
  _id: string;
  accountId: string;
  projectId?: string;
  environmentId?: string;
  name: string;
  description?: string;
  encryptedConfig?: string;
  encryptionIv?: string;
  encryptionTag?: string;
  createdAt: number;
  updatedAt: number;
}

function sandboxConfigFromConvex(doc: ConvexSandboxConfigDoc | null): SandboxConfigRecord | null {
  if (!doc) return null;
  const config = doc.encryptedConfig && doc.encryptionIv && doc.encryptionTag
    ? (decodeStoredConfigObject({
        encrypted: true as const,
        algorithm: "aes-256-gcm",
        ciphertext: doc.encryptedConfig,
        iv: doc.encryptionIv,
        tag: doc.encryptionTag,
      }) as unknown as SandboxConfig)
    : ({ provider: "lambda", permissionMode: "ask" } as SandboxConfig);
  return {
    accountId: doc.accountId,
    sandboxId: doc._id,
    ...(doc.projectId ? { projectId: doc.projectId } : {}),
    ...(doc.environmentId ? { environmentId: doc.environmentId } : {}),
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    config,
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
  };
}

interface ConvexWorkspaceConfigDoc {
  _id: string;
  accountId: string;
  name: string;
  description?: string;
  config: WorkspaceConfig;
  createdAt: number;
  updatedAt: number;
}

function workspaceConfigFromConvex(doc: ConvexWorkspaceConfigDoc | null): WorkspaceConfigRecord | null {
  if (!doc) return null;
  return {
    accountId: doc.accountId,
    workspaceId: doc._id,
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    config: doc.config ?? { storage: { provider: "s3" } },
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
  };
}

const sandboxConfigs: SandboxConfigStore = {
  async getById(accountId, sandboxId) {
    const doc = await getConvexClient().query(internal.sandboxConfigs.getById, {
      accountId: accountId as any,
      sandboxId: sandboxId as any,
    });
    return sandboxConfigFromConvex(doc as ConvexSandboxConfigDoc | null);
  },
  async list(accountId) {
    const docs = (await getConvexClient().query(internal.sandboxConfigs.list, {
      accountId: accountId as any,
    })) as ConvexSandboxConfigDoc[];
    return docs.map((d) => sandboxConfigFromConvex(d)!).filter(Boolean);
  },
  async create(accountId, input) {
    const normalized = normalizeCreateSandboxConfigInput(input);
    const encrypted = encryptConfigObject(normalized.config);
    const id = (await getConvexClient().mutation(internal.sandboxConfigs.create, {
      accountId: accountId as any,
      name: normalized.name,
      description: normalized.description,
      encryptedConfig: encrypted.ciphertext,
      encryptionIv: encrypted.iv,
      encryptionTag: encrypted.tag,
    })) as string;
    const created = await this.getById(accountId, id);
    if (!created) throw new Error("Failed to fetch created sandbox config");
    return created;
  },
  async update(accountId, sandboxId, rawPatch) {
    const existing = await this.getById(accountId, sandboxId);
    if (!existing) return null;
    const patch = normalizeUpdateSandboxConfigInput(existing.config, rawPatch);
    const encrypted = encryptConfigObject(patch.config);
    const args: Record<string, unknown> = {
      accountId: accountId as any,
      sandboxId: sandboxId as any,
      encryptedConfig: encrypted.ciphertext,
      encryptionIv: encrypted.iv,
      encryptionTag: encrypted.tag,
    };
    if (patch.name !== undefined) args.name = patch.name;
    if (patch.description !== undefined) args.description = patch.description ?? undefined;
    await getConvexClient().mutation(internal.sandboxConfigs.update, args as any);
    return this.getById(accountId, sandboxId);
  },
  async remove(accountId, sandboxId) {
    await getConvexClient().mutation(internal.sandboxConfigs.remove, {
      accountId: accountId as any,
      sandboxId: sandboxId as any,
    });
    return true;
  },
  async removeAllForAccount(accountId) {
    const list = await this.list(accountId);
    for (const r of list) {
      await this.remove(accountId, r.sandboxId);
    }
    return list.length;
  },
};

const workspaceConfigs: WorkspaceConfigStore = {
  async getById(accountId, workspaceId) {
    const doc = await getConvexClient().query(internal.workspaceConfigs.getById, {
      accountId: accountId as any,
      workspaceId: workspaceId as any,
    });
    return workspaceConfigFromConvex(doc as ConvexWorkspaceConfigDoc | null);
  },
  async list(accountId) {
    const docs = (await getConvexClient().query(internal.workspaceConfigs.list, {
      accountId: accountId as any,
    })) as ConvexWorkspaceConfigDoc[];
    return docs.map((d) => workspaceConfigFromConvex(d)!).filter(Boolean);
  },
  async create(accountId, input) {
    const normalized = normalizeCreateWorkspaceConfigInput(input);
    const id = (await getConvexClient().mutation(internal.workspaceConfigs.create, {
      accountId: accountId as any,
      name: normalized.name,
      description: normalized.description,
      config: normalized.config as any,
    })) as string;
    const created = await this.getById(accountId, id);
    if (!created) throw new Error("Failed to fetch created workspace config");
    return created;
  },
  async update(accountId, workspaceId, rawPatch) {
    const existing = await this.getById(accountId, workspaceId);
    if (!existing) return null;
    const patch = normalizeUpdateWorkspaceConfigInput(existing.config, rawPatch);
    const args: Record<string, unknown> = {
      accountId: accountId as any,
      workspaceId: workspaceId as any,
      config: patch.config,
    };
    if (patch.name !== undefined) args.name = patch.name;
    if (patch.description !== undefined) args.description = patch.description ?? undefined;
    await getConvexClient().mutation(internal.workspaceConfigs.update, args as any);
    return this.getById(accountId, workspaceId);
  },
  async remove(accountId, workspaceId) {
    await getConvexClient().mutation(internal.workspaceConfigs.remove, {
      accountId: accountId as any,
      workspaceId: workspaceId as any,
    });
    return true;
  },
  async removeAllForAccount(accountId) {
    const list = await this.list(accountId);
    for (const r of list) {
      await this.remove(accountId, r.workspaceId);
    }
    return list.length;
  },
};

interface ConvexAccountToolDoc {
  _id: string;
  accountId: string;
  name: string;
  description: string;
  inputSchema: AccountToolRecord["inputSchema"];
  bundleStorageKey: string;
  sha256: string;
  defaultConfig?: Record<string, unknown>;
  status: "active" | "deleted";
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

function accountToolFromConvex(doc: ConvexAccountToolDoc | null): AccountToolRecord | null {
  if (!doc) return null;
  return {
    accountId: doc.accountId,
    toolId: doc._id,
    name: doc.name,
    description: doc.description,
    inputSchema: doc.inputSchema,
    bundleStorageKey: doc.bundleStorageKey,
    sha256: doc.sha256,
    ...(doc.defaultConfig !== undefined ? { defaultConfig: doc.defaultConfig } : {}),
    status: doc.status,
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
    ...(doc.deletedAt ? { deletedAt: new Date(doc.deletedAt).toISOString() } : {}),
  };
}

const accountTools: AccountToolStore = {
  async getById(accountId, toolId) {
    const doc = await getConvexClient().query(internal.accountTools.getById, {
      accountId: accountId as any,
      toolId: toolId as any,
    });
    return accountToolFromConvex(doc as ConvexAccountToolDoc | null);
  },
  async list(accountId) {
    const docs = (await getConvexClient().query(internal.accountTools.list, {
      accountId: accountId as any,
    })) as ConvexAccountToolDoc[];
    return docs.map((d) => accountToolFromConvex(d)!).filter(Boolean);
  },
  async create(accountId, input) {
    const normalized = normalizeCreateAccountToolInput(input);
    const id = (await getConvexClient().mutation(internal.accountTools.create, {
      accountId: accountId as any,
      name: normalized.name,
      description: normalized.description,
      inputSchema: normalized.inputSchema as any,
      bundleStorageKey: normalized.bundleStorageKey,
      sha256: normalized.sha256,
      defaultConfig: normalized.defaultConfig,
    })) as string;
    const created = await this.getById(accountId, id);
    if (!created) throw new Error("Failed to fetch created account tool");
    return created;
  },
  async update(accountId, toolId, rawPatch) {
    const patch = normalizeUpdateAccountToolInput(rawPatch);
    await getConvexClient().mutation(internal.accountTools.update, {
      accountId: accountId as any,
      toolId: toolId as any,
      ...patch,
    } as any);
    return this.getById(accountId, toolId);
  },
  async remove(accountId, toolId) {
    await getConvexClient().mutation(internal.accountTools.remove, {
      accountId: accountId as any,
      toolId: toolId as any,
    });
    return true;
  },
  async removeAllForAccount(accountId) {
    const list = await this.list(accountId);
    for (const toolRecord of list) {
      await this.remove(accountId, toolRecord.toolId);
    }
    return list.length;
  },
};

export const convexStorageProvider: StorageProvider = {
  kind: "convex",
  accounts,
  agents,
  agentDeployments,
  crons,
  sandboxConfigs,
  workspaceConfigs,
  accountTools,
  usage,
};
