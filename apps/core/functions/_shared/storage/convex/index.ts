/**
 * Convex-backed StorageProvider. Used when STORAGE_PROVIDER=convex
 * (SaaS deployment). All calls go through ConvexHttpClient with a
 * deploy-key admin auth header.
 *
 * Read paths (the auth path + harness reads) are fully implemented.
 * Account-create / rotate-secret are owned by the cherry-coke side
 * (orgLifecycle) and intentionally throw here — filthy-panty does not
 * create accounts in SaaS mode. Agent + cron-job writes are wired so
 * the harness can persist normally.
 */

import { encryptAgentConfig, decodeStoredAgentConfig } from "../agent-config.ts";
import {
  normalizeCreateAgentInput,
  normalizeUpdateAgentInput,
} from "../agents.ts";
import {
  normalizeCreateCronJobInput,
  normalizeSchedulerGroupName,
  normalizeUpdateCronJobInput,
} from "../cron-jobs.ts";

// The convex/ submodule is only present in SaaS deployments. We load the
// generated API namespace lazily via require() so the open-source typecheck
// + CI build (which doesn't fetch the private submodule) still succeeds.
// ConvexHttpClient's typed `query`/`mutation` only accept public function
// refs; the submodule exposes internalQuery / internalMutation, so we cast
// at the boundary. Deploy-key auth permits calling these at runtime.
function loadInternalApi(): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../../../../convex/_generated/api").internal;
}
let _internal: any;
function internalApiRef(): any {
  if (!_internal) _internal = loadInternalApi();
  return _internal;
}
const internal: any = new Proxy({}, {
  get(_t, prop) { return internalApiRef()[prop as string]; },
});
import type {
  AccountRecord,
  AgentRecord,
  AccountStore,
  AgentStore,
  CronJobRecord,
  CronJobStore,
  StorageProvider,
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

interface ConvexCronJobDoc {
  _id: string;
  accountId: string;
  name: string;
  description?: string;
  agentId: string;
  prompt: string;
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

function cronJobFromConvex(doc: ConvexCronJobDoc | null): CronJobRecord | null {
  if (!doc) return null;
  return {
    accountId: doc.accountId,
    cronJobId: doc._id,
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    agentId: doc.agentId,
    prompt: doc.prompt,
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

const cronJobs: CronJobStore = {
  async getById(accountId, cronJobId) {
    const doc = await getConvexClient().query(internal.cronJobs.getById, {
      accountId: accountId as any,
      cronJobId: cronJobId as any,
    });
    return cronJobFromConvex(doc as ConvexCronJobDoc | null);
  },
  async list(accountId) {
    const docs = (await getConvexClient().query(internal.cronJobs.list, {
      accountId: accountId as any,
    })) as ConvexCronJobDoc[];
    return docs.map((d) => cronJobFromConvex(d)!).filter(Boolean);
  },
  async create(accountId, input, options) {
    const normalized = normalizeCreateCronJobInput(input);
    const schedulerGroupName = normalizeSchedulerGroupName(options.schedulerGroupName);
    const schedulerName = `${accountId}-${cryptoRandomId()}`;
    const id = (await getConvexClient().mutation(internal.cronJobs.create, {
      accountId: accountId as any,
      name: normalized.name,
      description: normalized.description,
      agentId: normalized.agentId as any,
      prompt: normalized.prompt,
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
  async update(accountId, cronJobId, rawPatch) {
    const patch = normalizeUpdateCronJobInput(rawPatch);
    await getConvexClient().mutation(internal.cronJobs.update, {
      accountId: accountId as any,
      cronJobId: cronJobId as any,
      name: patch.name,
      description: patch.description ?? undefined,
      agentId: patch.agentId as any,
      prompt: patch.prompt,
      conversationKey: patch.conversationKey ?? undefined,
      scheduleExpression: patch.scheduleExpression,
      timezone: patch.timezone ?? undefined,
      status: patch.status,
    });
    return this.getById(accountId, cronJobId);
  },
  async remove(accountId, cronJobId) {
    await getConvexClient().mutation(internal.cronJobs.remove, {
      accountId: accountId as any,
      cronJobId: cronJobId as any,
    });
    return true;
  },
  async markStarted(accountId, cronJobId) {
    await getConvexClient().mutation(internal.cronJobs.recordInvocation, {
      accountId: accountId as any,
      cronJobId: cronJobId as any,
      lastStatus: "started",
    });
  },
  async markCompleted(accountId, cronJobId) {
    await getConvexClient().mutation(internal.cronJobs.recordInvocation, {
      accountId: accountId as any,
      cronJobId: cronJobId as any,
      lastStatus: "completed",
    });
  },
  async markFailed(accountId, cronJobId, error) {
    await getConvexClient().mutation(internal.cronJobs.recordInvocation, {
      accountId: accountId as any,
      cronJobId: cronJobId as any,
      lastStatus: "failed",
      lastError: error,
    });
  },
};

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2, 14);
}

export const convexStorageProvider: StorageProvider = {
  kind: "convex",
  accounts,
  agents,
  cronJobs,
};
