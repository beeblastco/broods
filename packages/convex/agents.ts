/**
 * Agent CRUD scoped to an account. Every mutation revalidates the agent's
 * accountId against the caller-supplied accountId for defence in depth.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { authKit } from "./auth";
import { encryptAgentConfigBlob, substituteEnvPlaceholders } from "./model/agentConfigCodec";
import { backSyncCanvasFromAgentRow, mirrorAgentRowOntoConfig } from "./model/agentSync";
import { getActiveOrgForUser } from "./model/ownership/org";
import { agentsFields } from "./schema";

const agentDoc = v.object({
    ...agentsFields,
    _id: v.id("agents"),
    _creationTime: v.number(),
});

/**
 * Look up an agent by the public string `agentId` used in the filthy-panty
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
 * Public query: lists the caller's active-org agents. Used by the cron-jobs
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

export const create = internalMutation({
    args: {
        accountId: v.id("accounts"),
        name: v.string(),
        description: v.optional(v.string()),
        encryptedConfig: v.optional(v.string()),
        encryptionIv: v.optional(v.string()),
        encryptionTag: v.optional(v.string()),
    },
    returns: v.id("agents"),
    handler: async (ctx, args) => {
        const account = await ctx.db.get(args.accountId);
        if (!account) {
            throw new Error(`Account not found: ${args.accountId}`);
        }

        const now = Date.now();
        const agentRowId = await ctx.db.insert("agents", {
            accountId: args.accountId,
            name: args.name,
            description: args.description,
            encryptedConfig: args.encryptedConfig,
            encryptionIv: args.encryptionIv,
            encryptionTag: args.encryptionTag,
            createdAt: now,
            updatedAt: now,
        });

        // Back-sync to cherry-coke's canvas so API-created agents appear on
        // the org owner's default project/environment. Safe no-op when the
        // canvas surface isn't provisioned (no org owner / no projects).
        await backSyncCanvasFromAgentRow(ctx, agentRowId);

        return agentRowId;
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
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const { accountId, agentId, ...patch } = args;
        const normalized = ctx.db.normalizeId("agents", agentId);
        if (!normalized) {
            throw new Error("Agent does not belong to the supplied accountId");
        }
        const agent = await ctx.db.get(normalized);
        if (!agent || agent.accountId !== accountId) {
            throw new Error("Agent does not belong to the supplied accountId");
        }

        await ctx.db.patch(normalized, {
            ...(patch.name !== undefined && { name: patch.name }),
            ...(patch.description !== undefined && { description: patch.description }),
            ...(patch.encryptedConfig !== undefined && { encryptedConfig: patch.encryptedConfig }),
            ...(patch.encryptionIv !== undefined && { encryptionIv: patch.encryptionIv }),
            ...(patch.encryptionTag !== undefined && { encryptionTag: patch.encryptionTag }),
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
        variables: v.optional(v.array(v.object({ key: v.string(), value: v.string() }))),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
        if (!secret) throw new Error("ACCOUNT_CONFIG_ENCRYPTION_SECRET not set");
        const normalized = ctx.db.normalizeId("agents", args.agentId);
        if (!normalized) throw new Error("Unknown agentId");
        const variables: Record<string, string> = {};
        for (const entry of args.variables ?? []) variables[entry.key] = entry.value;
        const resolved = substituteEnvPlaceholders(args.config as Record<string, unknown>, variables);
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

        // Mirror cleanup onto cherry-coke's canvas: drop any agentConfigs row
        // and matching canvas node that referenced this agent.
        const linkedConfig = await ctx.db
            .query("agentConfigs")
            .withIndex("by_agentId", (q) => q.eq("agentId", normalized as unknown as string))
            .first();
        if (linkedConfig) {
            const layout = await ctx.db
                .query("canvasLayouts")
                .withIndex("by_projectId_and_environmentId", (q) =>
                    q.eq("projectId", linkedConfig.projectId).eq("environmentId", linkedConfig.environmentId),
                )
                .unique();
            if (layout) {
                const filtered = (layout.nodes as Array<{ data?: { agentConfigId?: string } }>).filter(
                    (n) => n.data?.agentConfigId !== linkedConfig._id,
                );
                if (filtered.length !== layout.nodes.length) {
                    await ctx.db.patch(layout._id, { nodes: filtered, updatedAt: Date.now() });
                }
            }
            await ctx.db.delete(linkedConfig._id);
        }

        await ctx.db.delete(normalized);

        return null;
    },
});
