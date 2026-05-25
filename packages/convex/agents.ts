/**
 * Agent CRUD scoped to an account. Every mutation revalidates the agent's
 * accountId against the caller-supplied accountId for defence in depth.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { authKit } from "./auth";
import { encryptAgentConfigBlob, substituteEnvPlaceholders } from "./model/agentConfigCodec";
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
        return await ctx.db.insert("agents", {
            accountId: args.accountId,
            name: args.name,
            description: args.description,
            encryptedConfig: args.encryptedConfig,
            encryptionIv: args.encryptionIv,
            encryptionTag: args.encryptionTag,
            createdAt: now,
            updatedAt: now,
        });
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
        await ctx.db.delete(normalized);

        return null;
    },
});
