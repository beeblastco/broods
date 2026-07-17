/**
 * Agent CRUD scoped to an account. Every mutation revalidates the agent's
 * accountId against the caller-supplied accountId for defence in depth.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { authKit } from "./auth";
import {
  encryptAgentConfigBlob,
  substituteEnvPlaceholders,
} from "./model/agentConfigCodec";
import { accountIdForProject } from "./model/auditEvents";
import {
  backSyncCanvasFromAgentRow,
  mirrorAgentRowOntoConfig,
} from "./model/agentSync";
import { getActiveOrgForUser } from "./model/ownership/org";
import { getProjectForRole } from "./model/ownership/project";
import { agentsInProject } from "./model/projectScope";
import { agentsFields } from "./schema";

const agentDoc = v.object({
  ...agentsFields,
  _id: v.id("agents"),
  _creationTime: v.number(),
});

/**
 * Look up an agent by the public string `agentId` used in the broods
 * HTTP contract. The validator accepts `v.string()` (not `v.id("agents")`)
 * so unknown / non-Convex-id values resolve to `null` (= "agent not found")
 * instead of throwing an ArgumentValidationError at the adapter boundary.
 */
export const getById = internalQuery({
  args: {
    accountId: v.id("accounts"),
    agentId: v.string(),
  },
  returns: v.union(agentDoc, v.null()),
  handler: async (ctx, args) => {
    const normalized = ctx.db.normalizeId("agents", args.agentId);
    if (!normalized) return null;
    const agent = await ctx.db.get(normalized);
    if (!agent || agent.accountId !== args.accountId) {
      return null;
    }

    return agent;
  },
});

/**
 * Public query: lists the caller's active-org agents. Used by the crons
 * UI dropdown to pick which agent a scheduled run targets.
 */
export const listForActiveOrg = query({
  args: {},
  returns: v.array(agentDoc),
  handler: async (ctx) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) {
      throw new Error("User not found or not authenticated");
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", authUser.id))
      .unique();
    if (!user) return [];

    const org = await getActiveOrgForUser(ctx, user._id);
    if (!org) return [];

    const account = await ctx.db
      .query("accounts")
      .withIndex("by_orgId", (q) => q.eq("orgId", org._id))
      .unique();
    if (!account) return [];

    return await ctx.db
      .query("agents")
      .withIndex("by_accountId", (q) => q.eq("accountId", account._id))
      .collect();
  },
});

export const list = internalQuery({
  args: { accountId: v.id("accounts") },
  returns: v.array(agentDoc),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agents")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();
  },
});

/**
 * Look up an account's agent by name. Names are unique per account (enforced
 * on create/rename), so config-plane clients can adopt an existing agent
 * instead of duplicating it.
 * @param accountId owning account
 * @param name agent name to look up
 * @returns agent document or null
 */
export const getByName = internalQuery({
  args: {
    accountId: v.id("accounts"),
    name: v.string(),
  },
  returns: v.union(agentDoc, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agents")
      .withIndex("by_accountId_and_name", (q) =>
        q.eq("accountId", args.accountId).eq("name", args.name),
      )
      .first();
  },
});

export const create = internalMutation({
  args: {
    accountId: v.id("accounts"),
    name: v.string(),
    description: v.optional(v.string()),
    encryptedConfig: v.optional(v.string()),
    encryptionIv: v.optional(v.string()),
    encryptionTag: v.optional(v.string()),
    encryptedSourceConfig: v.optional(v.string()),
    sourceEncryptionIv: v.optional(v.string()),
    sourceEncryptionTag: v.optional(v.string()),
  },
  returns: v.id("agents"),
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) {
      throw new Error(`Account not found: ${args.accountId}`);
    }

    // Serializable duplicate guard: racing creates conflict on this index
    // read, so the retried transaction sees the winner's row and rejects.
    const existing = await ctx.db
      .query("agents")
      .withIndex("by_accountId_and_name", (q) =>
        q.eq("accountId", args.accountId).eq("name", args.name),
      )
      .first();
    if (existing) {
      throw new Error(`Agent name already exists: ${args.name}`);
    }

    const now = Date.now();
    const agentRowId = await ctx.db.insert("agents", {
      accountId: args.accountId,
      name: args.name,
      description: args.description,
      encryptedConfig: args.encryptedConfig,
      encryptionIv: args.encryptionIv,
      encryptionTag: args.encryptionTag,
      encryptedSourceConfig: args.encryptedSourceConfig,
      sourceEncryptionIv: args.sourceEncryptionIv,
      sourceEncryptionTag: args.sourceEncryptionTag,
      createdAt: now,
      updatedAt: now,
    });

    // Back-sync to the dashboard's canvas so API-created agents appear on
    // the org owner's default project/environment. Safe no-op when the
    // canvas surface isn't provisioned (no org owner / no projects).
    await backSyncCanvasFromAgentRow(ctx, agentRowId);

    return agentRowId;
  },
});

/**
 * Lists the agents this project owns, for the project's scheduler.
 *
 * `agents` rows are account-scoped and carry no projectId; the link is
 * `agentConfigs.projectId`, so this resolves project → configs → agents.
 * Agents whose config row is missing belong to no project and are absent.
 * @param projectId the project to list agents for
 */
export const listForProject = query({
  args: { projectId: v.id("projects") },
  returns: v.array(agentDoc),
  handler: async (ctx, args) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    // Gate on project membership: projectId arrives from the URL, so an
    // unauthorized id must return nothing rather than another org's agents.
    const project = await getProjectForRole(ctx, user.id, args.projectId);
    if (!project) return [];

    const accountId = await accountIdForProject(ctx, args.projectId);
    if (!accountId) return [];

    return await agentsInProject(ctx, args.projectId, accountId);
  },
});

export const update = internalMutation({
  args: {
    accountId: v.id("accounts"),
    agentId: v.string(),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    encryptedConfig: v.optional(v.string()),
    encryptionIv: v.optional(v.string()),
    encryptionTag: v.optional(v.string()),
    encryptedSourceConfig: v.optional(v.string()),
    sourceEncryptionIv: v.optional(v.string()),
    sourceEncryptionTag: v.optional(v.string()),
    clearSourceConfig: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { accountId, agentId, clearSourceConfig, ...patch } = args;
    const normalized = ctx.db.normalizeId("agents", agentId);
    if (!normalized) {
      throw new Error("Agent does not belong to the supplied accountId");
    }
    const agent = await ctx.db.get(normalized);
    if (!agent || agent.accountId !== accountId) {
      throw new Error("Agent does not belong to the supplied accountId");
    }

    if (patch.name !== undefined && patch.name !== agent.name) {
      const existing = await ctx.db
        .query("agents")
        .withIndex("by_accountId_and_name", (q) =>
          q.eq("accountId", accountId).eq("name", patch.name!),
        )
        .first();
      if (existing) {
        throw new Error(`Agent name already exists: ${patch.name}`);
      }
    }

    await ctx.db.patch(normalized, {
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.description !== undefined && {
        description: patch.description,
      }),
      ...(patch.encryptedConfig !== undefined && {
        encryptedConfig: patch.encryptedConfig,
      }),
      ...(patch.encryptionIv !== undefined && {
        encryptionIv: patch.encryptionIv,
      }),
      ...(patch.encryptionTag !== undefined && {
        encryptionTag: patch.encryptionTag,
      }),
      ...(patch.encryptedSourceConfig !== undefined && {
        encryptedSourceConfig: patch.encryptedSourceConfig,
      }),
      ...(patch.sourceEncryptionIv !== undefined && {
        sourceEncryptionIv: patch.sourceEncryptionIv,
      }),
      ...(patch.sourceEncryptionTag !== undefined && {
        sourceEncryptionTag: patch.sourceEncryptionTag,
      }),
      ...(clearSourceConfig === true && {
        encryptedSourceConfig: undefined,
        sourceEncryptionIv: undefined,
        sourceEncryptionTag: undefined,
      }),
      updatedAt: Date.now(),
    });

    // Mirror API-side changes onto the canvas-side agentConfigs row so
    // the Details/Config/Variables tabs reflect what the API caller wrote.
    await mirrorAgentRowOntoConfig(ctx, normalized);

    return null;
  },
});

/**
 * Test utility: encrypts a raw `AgentConfig` against the deployment's
 * `ACCOUNT_CONFIG_ENCRYPTION_SECRET` and writes it onto the given agent.
 * Used by the CLI smoke-test to seed a working config without touching
 * the canvas / agentConfigs flow. Production sync should go through
 * `model/agentSync.pushEncryptedConfigToAgentRow` instead.
 */
export const seedEncryptedConfigForTest = internalMutation({
  args: {
    agentId: v.string(),
    config: v.any(),
    variables: v.optional(
      v.array(v.object({ key: v.string(), value: v.string() })),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
    if (!secret) throw new Error("ACCOUNT_CONFIG_ENCRYPTION_SECRET not set");
    const normalized = ctx.db.normalizeId("agents", args.agentId);
    if (!normalized) throw new Error("Unknown agentId");
    const variables: Record<string, string> = {};
    for (const entry of args.variables ?? [])
      variables[entry.key] = entry.value;
    const resolved = substituteEnvPlaceholders(
      args.config as Record<string, unknown>,
      variables,
    );
    const encrypted = await encryptAgentConfigBlob(resolved, secret);
    await ctx.db.patch(normalized, {
      encryptedConfig: encrypted.ciphertext,
      encryptionIv: encrypted.iv,
      encryptionTag: encrypted.tag,
      updatedAt: Date.now(),
    });
    await mirrorAgentRowOntoConfig(ctx, normalized);
    return null;
  },
});

export const remove = internalMutation({
  args: {
    accountId: v.id("accounts"),
    agentId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const normalized = ctx.db.normalizeId("agents", args.agentId);
    if (!normalized) {
      throw new Error("Agent does not belong to the supplied accountId");
    }
    const agent = await ctx.db.get(normalized);
    if (!agent || agent.accountId !== args.accountId) {
      throw new Error("Agent does not belong to the supplied accountId");
    }

    // Mirror cleanup onto the dashboard's canvas: drop any agentConfigs row
    // and matching canvas node that referenced this agent.
    const linkedConfig = await ctx.db
      .query("agentConfigs")
      .withIndex("by_agentId", (q) =>
        q.eq("agentId", normalized as unknown as string),
      )
      .first();
    if (linkedConfig) {
      const layout = await ctx.db
        .query("canvasLayouts")
        .withIndex("by_projectId_and_environmentId", (q) =>
          q
            .eq("projectId", linkedConfig.projectId)
            .eq("environmentId", linkedConfig.environmentId),
        )
        .unique();
      if (layout) {
        const filtered = (
          layout.nodes as Array<{ data?: { agentConfigId?: string } }>
        ).filter((n) => n.data?.agentConfigId !== linkedConfig._id);
        if (filtered.length !== layout.nodes.length) {
          await ctx.db.patch(layout._id, {
            nodes: filtered,
            updatedAt: Date.now(),
          });
        }
      }
      await ctx.db.delete(linkedConfig._id);
    }

    await ctx.db.delete(normalized);

    return null;
  },
});
