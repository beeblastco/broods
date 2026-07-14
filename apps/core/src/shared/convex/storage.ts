/**
 * Core storage backed by Convex. All calls go through ConvexHttpClient with a
 * deploy-key admin auth header.
 *
 * Hosted account lifecycle normally runs through orgLifecycle. The admin-only
 * core POST /accounts path remains supported for standalone accounts.
 */

import {
  decodeStoredAgentConfig,
  decodeStoredConfigObject,
} from "../domain/agent-config.ts";
import type { ModelMessage } from "ai";
import type { SandboxConfig } from "../domain/sandbox-config.ts";
import type { WorkspaceConfig } from "../domain/workspace-config.ts";
import type { AccountToolRecord } from "../domain/account-tools.ts";
import type { AccountHookRecord } from "../domain/account-hooks.ts";
import type { AgentPolicyRecord } from "../domain/agent-policy.ts";
import { taskUsage } from "./usage.ts";
import {
  createAccountId,
  createAccountSecret,
  hashAccountSecret,
  normalizeCreateAccountInput,
  type AccountRecord,
} from "../domain/accounts.ts";
import type { AgentRecord } from "../domain/agents.ts";
import type { CronRecord } from "../domain/cron.ts";
import type { SandboxConfigRecord } from "../domain/sandbox-config.ts";
import type { WorkspaceConfigRecord } from "../domain/workspace-config.ts";

// ConvexHttpClient's typed `query`/`mutation` only accept public function
// refs; the backend package exposes internalQuery / internalMutation, so we
// cast at the boundary. Deploy-key auth permits calling these at runtime.
// require() (not import) keeps the backend's generated types out of this
// package's typecheck program — its sources are checked by their own
// tsconfig — while Bun still resolves and bundles the module statically.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const internal: any = require("@broods/convex/_generated/api").internal;
import type {
  AgentDeploymentScope,
  Storage,
} from "../storage.ts";
import { getConvexClient } from "./client.ts";

const ACCOUNT_DELETE_MAX_BATCHES = 100_000;
const DELETE_CONCURRENCY = 20;

async function removeInBatches<T>(docs: T[], remove: (doc: T) => Promise<unknown>): Promise<void> {
  for (let offset = 0; offset < docs.length; offset += DELETE_CONCURRENCY) {
    await Promise.all(docs.slice(offset, offset + DELETE_CONCURRENCY).map(remove));
  }
}

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

const accounts: Storage["accounts"] = {
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
  async create(input) {
    const normalized = normalizeCreateAccountInput(input);
    const secret = createAccountSecret();
    const doc = await getConvexClient().mutation(internal.accounts.create, {
      orgId: `admin:${createAccountId()}`,
      username: normalized.username,
      description: normalized.description,
      secretHash: hashAccountSecret(secret),
      status: "active",
    }) as ConvexAccountDoc;
    const account = accountFromConvex(doc);
    if (!account) throw new Error("Failed to fetch created account");
    return { account, secret };
  },
  async disable(accountId) {
    const doc = await getConvexClient().mutation(internal.accounts.update, {
      accountId: accountId as any,
      status: "disabled",
    });
    return accountFromConvex(doc as ConvexAccountDoc | null);
  },
  async remove(accountId) {
    for (let batch = 0; batch < ACCOUNT_DELETE_MAX_BATCHES; batch += 1) {
      const complete = await getConvexClient().mutation(internal.accounts.removeBatch, {
        accountId: accountId as any,
      });
      if (complete) return true;
    }
    throw new Error(`Account deletion exceeded ${ACCOUNT_DELETE_MAX_BATCHES} Convex batches`);
  },
};

const agents: Storage["agents"] = {
  async getById(accountId, agentId) {
    const doc = await getConvexClient().query(internal.agents.getById, {
      accountId: accountId as any,
      agentId: agentId as any,
    });
    return agentFromConvex(doc as ConvexAgentDoc | null);
  },
  async removeAllForAccount(accountId) {
    const docs = (await getConvexClient().query(internal.agents.list, {
      accountId: accountId as any,
    })) as ConvexAgentDoc[];
    await removeInBatches(docs, (doc) =>
      getConvexClient().mutation(internal.agents.remove, {
        accountId: accountId as any,
        agentId: doc._id as any,
      })
    );
    return docs.length;
  },
};

const agentDeployments: Storage["agentDeployments"] = {
  async getByApiKeyHash(apiKeyHash) {
    const doc = await getConvexClient().query(internal.agentDeployments.getByApiKeyHash, {
      apiKeyHash: apiKeyHash,
    }) as AgentDeploymentScope | null;
    return doc;
  },
  async getByAgentId(accountId, agentId) {
    const doc = await getConvexClient().query(internal.agentDeployments.getByAgentId, {
      accountId: accountId as any,
      agentId: agentId,
    }) as AgentDeploymentScope | null;
    return doc;
  },
};

const crons: Storage["crons"] = {
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
};

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
    : ({ provider: "sandbox", permissionMode: "ask", network: { mode: "deny-all" } } as SandboxConfig);
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

const sandboxConfigs: Storage["sandboxConfigs"] = {
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
  async removeAllForAccount(accountId) {
    const docs = (await getConvexClient().query(internal.sandboxConfigs.list, {
      accountId: accountId as any,
    })) as ConvexSandboxConfigDoc[];
    await removeInBatches(docs, (doc) =>
      getConvexClient().mutation(internal.sandboxConfigs.remove, {
        accountId: accountId as any,
        sandboxId: doc._id as any,
      })
    );
    return docs.length;
  },
};

const workspaceConfigs: Storage["workspaceConfigs"] = {
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
  async removeAllForAccount(accountId) {
    const docs = (await getConvexClient().query(internal.workspaceConfigs.list, {
      accountId: accountId as any,
    })) as ConvexWorkspaceConfigDoc[];
    await removeInBatches(docs, (doc) =>
      getConvexClient().mutation(internal.workspaceConfigs.remove, {
        accountId: accountId as any,
        workspaceId: doc._id as any,
      })
    );
    return docs.length;
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
  runtime?: "isolate" | "sandbox";
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
    runtime: doc.runtime === "isolate" ? "isolate" : "sandbox",
    ...(doc.defaultConfig !== undefined ? { defaultConfig: doc.defaultConfig } : {}),
    status: doc.status,
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
    ...(doc.deletedAt ? { deletedAt: new Date(doc.deletedAt).toISOString() } : {}),
  };
}

interface ConvexAgentPolicyDoc {
  _id: string;
  accountId: string;
  name: string;
  description?: string;
  document: AgentPolicyRecord["document"];
  status: "active" | "deleted";
  createdAt: number;
  updatedAt: number;
}

function agentPolicyFromConvex(doc: ConvexAgentPolicyDoc | null): AgentPolicyRecord | null {
  if (!doc) return null;

  return {
    accountId: doc.accountId,
    policyId: doc._id,
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    document: doc.document,
    status: doc.status,
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
  };
}

interface ConvexAccountHookDoc {
  _id: string;
  accountId: string;
  name: string;
  description?: string;
  events: AccountHookRecord["events"];
  bundleStorageKey: string;
  sha256: string;
  status: "active" | "deleted";
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

function accountHookFromConvex(doc: ConvexAccountHookDoc | null): AccountHookRecord | null {
  if (!doc) return null;
  return {
    accountId: doc.accountId,
    hookId: doc._id,
    name: doc.name,
    ...(doc.description !== undefined ? { description: doc.description } : {}),
    events: doc.events,
    bundleStorageKey: doc.bundleStorageKey,
    sha256: doc.sha256,
    status: doc.status,
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
    ...(doc.deletedAt ? { deletedAt: new Date(doc.deletedAt).toISOString() } : {}),
  };
}

const agentPolicies: Storage["agentPolicies"] = {
  async getById(accountId, policyId) {
    const doc = await getConvexClient().query(internal.agentPolicies.getById, {
      accountId: accountId as any,
      policyId: policyId,
    });

    return agentPolicyFromConvex(doc as ConvexAgentPolicyDoc | null);
  },
};

const accountTools: Storage["accountTools"] = {
  async getById(accountId, toolId) {
    const doc = await getConvexClient().query(internal.accountTools.getById, {
      accountId: accountId as any,
      toolId: toolId as any,
    });
    return accountToolFromConvex(doc as ConvexAccountToolDoc | null);
  },
  async removeAllForAccount(accountId) {
    const docs = (await getConvexClient().query(internal.accountTools.list, {
      accountId: accountId as any,
    })) as ConvexAccountToolDoc[];
    await removeInBatches(docs, (doc) =>
      getConvexClient().mutation(internal.accountTools.remove, {
        accountId: accountId as any,
        toolId: doc._id as any,
      })
    );
    return docs.length;
  },
};

const accountHooks: Storage["accountHooks"] = {
  async getById(accountId, hookId) {
    const doc = await getConvexClient().query(internal.accountHooks.getById, {
      accountId: accountId as any,
      hookId: hookId as any,
    });
    return accountHookFromConvex(doc as ConvexAccountHookDoc | null);
  },
  async removeAllForAccount(accountId) {
    const docs = (await getConvexClient().query(internal.accountHooks.list, {
      accountId: accountId as any,
    })) as ConvexAccountHookDoc[];
    await removeInBatches(docs, (doc) =>
      getConvexClient().mutation(internal.accountHooks.remove, {
        accountId: accountId as any,
        hookId: doc._id as any,
      })
    );
    return docs.length;
  },
};

export const convexStorage: Storage = {
  accounts,
  agents,
  agentDeployments,
  crons,
  sandboxConfigs,
  workspaceConfigs,
  agentPolicies,
  accountTools,
  accountHooks,
  taskUsage,
};
