/**
 * Core storage backed by Convex. All calls go through ConvexHttpClient with a
 * deploy-key admin auth header.
 *
 * Hosted account lifecycle normally runs through orgLifecycle. The admin-only
 * core POST /v1/accounts path remains supported for standalone accounts.
 */

import type { ModelMessage } from "ai";
import type { AccountHookRecord } from "../domain/account-hooks.ts";
import type {
  McpOauth,
  McpRecord,
  McpRuntime,
  McpTransport,
} from "../domain/mcp.ts";
import {
  createAccountId,
  createAccountSecret,
  hashAccountSecret,
  normalizeCreateAccountInput,
  type AccountRecord,
} from "../domain/accounts.ts";
import type { AgentConfig } from "../domain/agent-config.ts";
import type { PolicyRecord } from "../domain/policy.ts";
import type { AgentRecord } from "../domain/agents.ts";
import type {
  ChannelRecord,
  ChannelRecordConfig,
} from "../domain/channel-record.ts";
import type { CronRecord } from "../domain/cron.ts";
import type {
  SandboxConfig,
  SandboxConfigRecord,
} from "../domain/sandbox-config.ts";
import type {
  WorkspaceConfig,
  WorkspaceConfigRecord,
} from "../domain/workspace-config.ts";
import type { RolePrincipal } from "@broods/convex/model/apiAuthorization";
import type {
  AgentDeploymentScope,
  Storage,
  StoredConnection,
} from "../storage.ts";
import { budgets } from "./budgets.ts";
import { decryptAccountBlob } from "./account-keys.ts";
import { getConvexClient } from "./client.ts";
import { auditLedger } from "./audit-ledger.ts";
import { taskUsage } from "./usage.ts";

// ConvexHttpClient's typed `query`/`mutation` only accept public function
// refs; the backend package exposes internalQuery / internalMutation, so we
// cast at the boundary. Deploy-key auth permits calling these at runtime.
// require() (not import) keeps the backend's generated types out of this
// package's typecheck program, since its own tsconfig checks those sources,
// while Bun still resolves and bundles the module statically.
const internal: any = require("@broods/convex/_generated/api").internal;

const ACCOUNT_DELETE_MAX_BATCHES = 100_000;
const DELETE_CONCURRENCY = 20;

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

async function agentFromConvex(
  doc: ConvexAgentDoc | null,
): Promise<AgentRecord | null> {
  if (!doc) return null;
  const config =
    doc.encryptedConfig && doc.encryptionIv && doc.encryptionTag
      ? ((await decryptAccountBlob(doc.accountId, "agents:encryptedConfig", {
          ciphertext: doc.encryptedConfig,
          iv: doc.encryptionIv,
          tag: doc.encryptionTag,
        })) as AgentConfig)
      : {};

  return {
    accountId: doc.accountId,
    agentId: doc._id,
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    config: config,
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
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
    ...(doc.lastInvokedAt
      ? { lastInvokedAt: new Date(doc.lastInvokedAt).toISOString() }
      : {}),
    ...(doc.lastStatus ? { lastStatus: doc.lastStatus } : {}),
    ...(doc.lastError ? { lastError: doc.lastError } : {}),
  };
}

const accounts: Storage["accounts"] = {
  getById: async function (accountId) {
    const doc = await getConvexClient().query(
      internal.account.accounts.getById,
      {
        accountId: accountId,
      },
    );

    return accountFromConvex(doc as ConvexAccountDoc | null);
  },
  getBySecretHash: async function (secretHash) {
    const doc = await getConvexClient().query(
      internal.account.accounts.getBySecretHash,
      {
        secretHash: secretHash,
      },
    );

    return accountFromConvex(doc as ConvexAccountDoc | null);
  },
  create: async function (input) {
    const normalized = normalizeCreateAccountInput(input);
    const secret = createAccountSecret();
    const doc = (await getConvexClient().mutation(
      internal.account.accounts.create,
      {
        orgId: `admin:${createAccountId()}`,
        username: normalized.username,
        description: normalized.description,
        secretHash: hashAccountSecret(secret),
        status: "active",
      },
    )) as ConvexAccountDoc;
    const account = accountFromConvex(doc);
    if (!account) throw new Error("Failed to fetch created account");

    return { account: account, secret: secret };
  },
  disable: async function (accountId) {
    const doc = await getConvexClient().mutation(
      internal.account.accounts.update,
      {
        accountId: accountId,
        status: "disabled",
      },
    );

    return accountFromConvex(doc as ConvexAccountDoc | null);
  },
  remove: async function (accountId) {
    for (let batch = 0; batch < ACCOUNT_DELETE_MAX_BATCHES; batch += 1) {
      const complete = await getConvexClient().mutation(
        internal.account.accounts.removeBatch,
        {
          accountId: accountId,
        },
      );
      if (complete) return true;
    }
    throw new Error(
      `Account deletion exceeded ${ACCOUNT_DELETE_MAX_BATCHES} Convex batches`,
    );
  },
};

const agents: Storage["agents"] = {
  getById: async function (accountId, agentId) {
    const doc = await getConvexClient().query(internal.agent.agents.getById, {
      accountId: accountId,
      agentId: agentId,
    });

    return await agentFromConvex(doc as ConvexAgentDoc | null);
  },
  listForEndpoint: async function (accountId, endpointId) {
    const docs = (await getConvexClient().query(
      internal.agent.agents.listForEndpoint,
      {
        accountId: accountId,
        endpointId: endpointId,
      },
    )) as ConvexAgentDoc[];

    return (await Promise.all(docs.map((doc) => agentFromConvex(doc)))).filter(
      (record) => record !== null,
    );
  },
  listForProduction: async function (accountId) {
    const docs = (await getConvexClient().query(
      internal.agent.agents.listForProduction,
      { accountId: accountId },
    )) as ConvexAgentDoc[];

    return (await Promise.all(docs.map((doc) => agentFromConvex(doc)))).filter(
      (record) => record !== null,
    );
  },
  removeAllForAccount: async function (accountId) {
    const docs = (await getConvexClient().query(internal.agent.agents.list, {
      accountId: accountId,
    })) as ConvexAgentDoc[];
    await removeInBatches(docs, (doc) =>
      getConvexClient().mutation(internal.agent.agents.remove, {
        accountId: accountId,
        agentId: doc._id,
      }),
    );

    return docs.length;
  },
};

const agentDeployments: Storage["agentDeployments"] = {
  getByApiKeyHash: async function (apiKeyHash) {
    const doc = (await getConvexClient().query(
      internal.agent.deployments.getByApiKeyHash,
      {
        apiKeyHash: apiKeyHash,
      },
    )) as (AgentDeploymentScope & { account: ConvexAccountDoc }) | null;
    const account = accountFromConvex(doc?.account ?? null);

    return doc && account ? { ...doc, account: account } : null;
  },
  touchLastUsed: async function (apiKeyHash, usedAt) {
    await getConvexClient().mutation(internal.agent.deployments.touchLastUsed, {
      apiKeyHash: apiKeyHash,
      usedAt: usedAt,
    });
  },
  getByAgentId: async function (accountId, agentId) {
    const doc = (await getConvexClient().query(
      internal.agent.deployments.getByAgentId,
      {
        accountId: accountId,
        agentId: agentId,
      },
    )) as AgentDeploymentScope | null;

    return doc;
  },
};

const crons: Storage["crons"] = {
  // agent/crons.create inserts the row and registers its schedule in one
  // transaction, so neither can orphan the other.
  create: async function (accountId, input) {
    return (await getConvexClient().mutation(internal.agent.crons.create, {
      accountId: accountId,
      input: input,
    })) as CronRecord;
  },
  getById: async function (accountId, cronId) {
    const doc = await getConvexClient().query(internal.agent.crons.getById, {
      accountId: accountId,
      cronId: cronId,
    });

    return cronFromConvex(doc as ConvexCronDoc | null);
  },
  list: async function (accountId, agentId) {
    const docs = (await getConvexClient().query(internal.agent.crons.list, {
      accountId: accountId,
      ...(agentId ? { agentId: agentId } : {}),
    })) as ConvexCronDoc[];

    return docs.map((d) => cronFromConvex(d)!).filter(Boolean);
  },
  // agent/crons.remove drops the registered schedule and the row together, so
  // a schedule can never outlive the cron row that names it.
  remove: async function (accountId, cronId) {
    return (await getConvexClient().mutation(internal.agent.crons.remove, {
      accountId: accountId,
      cronId: cronId,
    })) as boolean;
  },
  // agent/crons.update patches the row and replaces the registered schedule
  // in one transaction, so a schedule the scheduler rejects never reaches the
  // stored job.
  update: async function (accountId, cronId, patch) {
    return (await getConvexClient().mutation(internal.agent.crons.update, {
      accountId: accountId,
      cronId: cronId,
      patch: patch,
    })) as CronRecord | null;
  },
  markFailed: async function (accountId, cronId, error, firedAt) {
    await getConvexClient().mutation(internal.agent.crons.recordFailedFire, {
      accountId: accountId,
      cronId: cronId,
      error: error,
      firedAt: firedAt.getTime(),
    });
  },
  createRun: async function (input, firedAt) {
    const runId = (await getConvexClient().mutation(
      internal.agent.crons.createRun,
      {
        accountId: input.accountId,
        cronId: input.cronId,
        eventId: input.eventId,
        conversationKey: input.conversationKey,
        firedAt: firedAt.getTime(),
      },
    )) as string;

    return {
      ...input,
      runId: runId,
      status: "started",
      startedAt: new Date().toISOString(),
    };
  },
  completeRun: async function (accountId, cronId, runId, result) {
    await getConvexClient().mutation(internal.agent.crons.completeRun, {
      accountId: accountId,
      cronId: cronId,
      runId: runId,
      result: result,
    });
  },
  failRun: async function (accountId, cronId, runId, error) {
    await getConvexClient().mutation(internal.agent.crons.failRun, {
      accountId: accountId,
      cronId: cronId,
      runId: runId,
      error: error,
    });
  },
};

interface ConvexSandboxConfigDoc {
  _id: string;
  accountId: string;
  projectId?: string;
  stageId?: string;
  name: string;
  description?: string;
  encryptedConfig?: string;
  encryptionIv?: string;
  encryptionTag?: string;
  createdAt: number;
  updatedAt: number;
}

async function sandboxConfigFromConvex(
  doc: ConvexSandboxConfigDoc | null,
): Promise<SandboxConfigRecord | null> {
  if (!doc) return null;
  const config =
    doc.encryptedConfig && doc.encryptionIv && doc.encryptionTag
      ? ((await decryptAccountBlob(
          doc.accountId,
          "sandboxConfigs:encryptedConfig",
          {
            ciphertext: doc.encryptedConfig,
            iv: doc.encryptionIv,
            tag: doc.encryptionTag,
          },
        )) as unknown as SandboxConfig)
      : ({
          provider: "sandbox",
          permissionMode: "ask",
          network: { mode: "deny-all" },
        } as SandboxConfig);

  return {
    accountId: doc.accountId,
    sandboxId: doc._id,
    ...(doc.projectId ? { projectId: doc.projectId } : {}),
    ...(doc.stageId ? { stageId: doc.stageId } : {}),
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    config: config,
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

function workspaceConfigFromConvex(
  doc: ConvexWorkspaceConfigDoc | null,
): WorkspaceConfigRecord | null {
  if (!doc) return null;
  const config = doc.config ?? { storage: { provider: "s3" } };

  return {
    accountId: doc.accountId,
    workspaceId: doc._id,
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    // An R2 mount mints its credentials per workspace, so it carries the row's identity.
    config:
      config.storage?.auth?.type === "r2"
        ? {
            ...config,
            storage: {
              ...config.storage,
              owner: { accountId: doc.accountId, workspaceId: doc._id },
            },
          }
        : config,
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
  };
}

interface ConvexChannelRecordDoc {
  _id: string;
  accountId: string;
  platform: string;
  externalId: string;
  workspaceRef?: string;
  name: string;
  description?: string;
  config: ChannelRecordConfig;
  status: "active" | "deleted";
  createdAt: number;
  updatedAt: number;
}

function channelRecordFromConvex(
  doc: ConvexChannelRecordDoc | null,
): ChannelRecord | null {
  if (!doc) return null;

  return {
    accountId: doc.accountId,
    channelRecordId: doc._id,
    platform: doc.platform,
    externalId: doc.externalId,
    ...(doc.workspaceRef ? { workspaceRef: doc.workspaceRef } : {}),
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    config: doc.config ?? { agentBindings: [] },
    status: doc.status,
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
  };
}

const channelRecords: Storage["channelRecords"] = {
  getById: async function (accountId, channelRecordId) {
    const doc = await getConvexClient().query(
      internal.channel.records.getById,
      {
        accountId: accountId,
        channelRecordId: channelRecordId,
      },
    );

    return channelRecordFromConvex(doc as ConvexChannelRecordDoc | null);
  },
  getByExternalId: async function (accountId, platform, externalId) {
    const doc = await getConvexClient().query(
      internal.channel.records.getByExternalId,
      {
        accountId: accountId,
        platform: platform,
        externalId: externalId,
      },
    );

    return channelRecordFromConvex(doc as ConvexChannelRecordDoc | null);
  },
  list: async function (accountId) {
    const docs = (await getConvexClient().query(
      internal.channel.records.listActive,
      {
        accountId: accountId,
      },
    )) as ConvexChannelRecordDoc[];

    return docs.map((doc) => channelRecordFromConvex(doc)!).filter(Boolean);
  },
  removeAllForAccount: async function (accountId) {
    // The full list on purpose: soft-deleted tombstones must go with the
    // account, and listActive never returns them.
    const docs = (await getConvexClient().query(internal.channel.records.list, {
      accountId: accountId,
    })) as ConvexChannelRecordDoc[];
    await removeInBatches(docs, (doc) =>
      getConvexClient().mutation(internal.channel.records.remove, {
        accountId: accountId,
        channelRecordId: doc._id,
      }),
    );

    return docs.length;
  },
};

const sandboxConfigs: Storage["sandboxConfigs"] = {
  getById: async function (accountId, sandboxId) {
    const doc = await getConvexClient().query(
      internal.sandbox.configs.getById,
      {
        accountId: accountId,
        sandboxId: sandboxId,
      },
    );

    return await sandboxConfigFromConvex(doc as ConvexSandboxConfigDoc | null);
  },
  list: async function (accountId) {
    const docs = (await getConvexClient().query(internal.sandbox.configs.list, {
      accountId: accountId,
    })) as ConvexSandboxConfigDoc[];

    return (
      await Promise.all(docs.map((doc) => sandboxConfigFromConvex(doc)))
    ).filter((record) => record !== null);
  },
  removeAllForAccount: async function (accountId) {
    const docs = (await getConvexClient().query(internal.sandbox.configs.list, {
      accountId: accountId,
    })) as ConvexSandboxConfigDoc[];
    await removeInBatches(docs, (doc) =>
      getConvexClient().mutation(internal.sandbox.configs.remove, {
        accountId: accountId,
        sandboxId: doc._id,
      }),
    );

    return docs.length;
  },
};

const workspaceConfigs: Storage["workspaceConfigs"] = {
  getById: async function (accountId, workspaceId) {
    const doc = await getConvexClient().query(
      internal.workspace.configs.getById,
      {
        accountId: accountId,
        workspaceId: workspaceId,
      },
    );

    return workspaceConfigFromConvex(doc as ConvexWorkspaceConfigDoc | null);
  },
  list: async function (accountId) {
    const docs = (await getConvexClient().query(
      internal.workspace.configs.list,
      {
        accountId: accountId,
      },
    )) as ConvexWorkspaceConfigDoc[];

    return docs.map((d) => workspaceConfigFromConvex(d)!).filter(Boolean);
  },
  mintR2Credentials: async function (accountId, workspaceId, prefix) {
    return await getConvexClient().mutation(
      internal.workspace.configs.r2Credentials,
      { accountId: accountId, workspaceId: workspaceId, prefix: prefix },
    );
  },
  removeAllForAccount: async function (accountId) {
    const docs = (await getConvexClient().query(
      internal.workspace.configs.list,
      {
        accountId: accountId,
      },
    )) as ConvexWorkspaceConfigDoc[];
    await removeInBatches(docs, (doc) =>
      getConvexClient().mutation(internal.workspace.configs.remove, {
        accountId: accountId,
        workspaceId: doc._id,
      }),
    );

    return docs.length;
  },
};

interface ConvexMcpDoc {
  _id: string;
  accountId: string;
  projectId: string;
  stageId: string;
  name: string;
  description?: string;
  transport: McpTransport;
  workersCompatible?: boolean;
  runtime?: McpRuntime;
  url?: string;
  sandbox?: string;
  command?: string[];
  bundleStorageKey?: string;
  sha256?: string;
  headers?: Record<string, string>;
  oauth?: McpOauth;
  allowedTools?: string[];
  disabled?: boolean;
  status: "active" | "deleted";
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

function mcpFromConvex(doc: ConvexMcpDoc | null): McpRecord | null {
  if (!doc) return null;

  return {
    accountId: doc.accountId,
    serverId: doc._id,
    projectId: doc.projectId,
    stageId: doc.stageId,
    name: doc.name,
    ...(doc.description !== undefined ? { description: doc.description } : {}),
    transport: doc.transport,
    ...(doc.workersCompatible !== undefined
      ? { workersCompatible: doc.workersCompatible }
      : {}),
    ...(doc.runtime !== undefined ? { runtime: doc.runtime } : {}),
    ...(doc.url !== undefined ? { url: doc.url } : {}),
    ...(doc.sandbox !== undefined ? { sandbox: doc.sandbox } : {}),
    ...(doc.command !== undefined ? { command: doc.command } : {}),
    ...(doc.bundleStorageKey !== undefined
      ? { bundleStorageKey: doc.bundleStorageKey }
      : {}),
    ...(doc.sha256 !== undefined ? { sha256: doc.sha256 } : {}),
    ...(doc.headers !== undefined ? { headers: doc.headers } : {}),
    ...(doc.oauth !== undefined ? { oauth: doc.oauth } : {}),
    ...(doc.allowedTools !== undefined
      ? { allowedTools: doc.allowedTools }
      : {}),
    ...(doc.disabled !== undefined ? { disabled: doc.disabled } : {}),
    status: doc.status,
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
    ...(doc.deletedAt
      ? { deletedAt: new Date(doc.deletedAt).toISOString() }
      : {}),
  };
}

interface ConvexAgentPolicyDoc {
  _id: string;
  accountId: string;
  name: string;
  description?: string;
  document: PolicyRecord["document"];
  status: "active" | "deleted";
  createdAt: number;
  updatedAt: number;
}

function agentPolicyFromConvex(
  doc: ConvexAgentPolicyDoc | null,
): PolicyRecord | null {
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

function accountHookFromConvex(
  doc: ConvexAccountHookDoc | null,
): AccountHookRecord | null {
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
    ...(doc.deletedAt
      ? { deletedAt: new Date(doc.deletedAt).toISOString() }
      : {}),
  };
}

const agentPolicies: Storage["agentPolicies"] = {
  getById: async function (accountId, policyId) {
    const doc = await getConvexClient().query(internal.agent.policies.getById, {
      accountId: accountId,
      policyId: policyId,
    });

    return agentPolicyFromConvex(doc as ConvexAgentPolicyDoc | null);
  },
};

const mcp: Storage["mcp"] = {
  getById: async function (accountId, serverId) {
    const doc = await getConvexClient().query(internal.account.mcp.getById, {
      accountId: accountId,
      serverId: serverId,
    });

    return mcpFromConvex(doc as ConvexMcpDoc | null);
  },
  removeAllForAccount: async function (accountId) {
    const docs = (await getConvexClient().query(internal.account.mcp.list, {
      accountId: accountId,
    })) as ConvexMcpDoc[];
    await removeInBatches(docs, (doc) =>
      getConvexClient().mutation(internal.account.mcp.remove, {
        accountId: accountId,
        serverId: doc._id,
      }),
    );

    return docs.length;
  },
};

const accountHooks: Storage["accountHooks"] = {
  getById: async function (accountId, hookId) {
    const doc = await getConvexClient().query(internal.account.hooks.getById, {
      accountId: accountId,
      hookId: hookId,
    });

    return accountHookFromConvex(doc as ConvexAccountHookDoc | null);
  },
  removeAllForAccount: async function (accountId) {
    const docs = (await getConvexClient().query(internal.account.hooks.list, {
      accountId: accountId,
    })) as ConvexAccountHookDoc[];
    await removeInBatches(docs, (doc) =>
      getConvexClient().mutation(internal.account.hooks.remove, {
        accountId: accountId,
        hookId: doc._id,
      }),
    );

    return docs.length;
  },
};

const machineConnections: Storage["machineConnections"] = {
  connected: async function (connection) {
    await getConvexClient().mutation(
      internal.sandbox.machines.connected,
      connection,
    );
  },
  disconnected: async function (ref) {
    await getConvexClient().mutation(
      internal.sandbox.machines.disconnected,
      ref,
    );
  },
  seen: async function (ref) {
    await getConvexClient().mutation(internal.sandbox.machines.seen, ref);
  },
};

const connections: Storage["connections"] = {
  load: async function (accountId, type) {
    return (await getConvexClient().query(internal.account.connections.load, {
      accountId: accountId,
      type: type,
    })) as StoredConnection | null;
  },
  saveRefreshed: async function (accountId, type, loaded, refreshed) {
    return (await getConvexClient().mutation(
      internal.account.connections.saveRefreshed,
      {
        accountId: accountId,
        type: type,
        loadedUpdatedAt: loaded.updatedAt,
        ...refreshed,
      },
    )) as boolean;
  },
};

const roleSessions: Storage["roleSessions"] = {
  resolveByTokenHash: async function (tokenHash) {
    return (await getConvexClient().query(
      internal.account.roles.resolveSession,
      {
        tokenHash: tokenHash,
      },
    )) as RolePrincipal | null;
  },
};

export const convexStorage: Storage = {
  auditLedger: auditLedger,
  accounts: accounts,
  agents: agents,
  budgets: budgets,
  agentDeployments: agentDeployments,
  channelRecords: channelRecords,
  crons: crons,
  sandboxConfigs: sandboxConfigs,
  workspaceConfigs: workspaceConfigs,
  agentPolicies: agentPolicies,
  accountHooks: accountHooks,
  machineConnections: machineConnections,
  mcp: mcp,
  connections: connections,
  roleSessions: roleSessions,
  taskUsage: taskUsage,
};

async function removeInBatches<T>(
  docs: T[],
  remove: (doc: T) => Promise<unknown>,
): Promise<void> {
  for (let offset = 0; offset < docs.length; offset += DELETE_CONCURRENCY) {
    await Promise.all(
      docs.slice(offset, offset + DELETE_CONCURRENCY).map(remove),
    );
  }
}
