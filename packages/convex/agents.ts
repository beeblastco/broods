/**
 * Agent CRUD scoped to an account. Every mutation revalidates the agent's
 * accountId against the caller-supplied accountId for defence in depth.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { agentsFields } from "./schema";

const agentDoc = v.object({
    ...agentsFields,
    _id: v.id("agents"),
    _creationTime: v.number(),
});

async function requireAccountOwnsAgent(
    ctx: { db: { get: (id: import("./_generated/dataModel").Id<"agents">) => Promise<unknown> } },
    accountId: import("./_generated/dataModel").Id<"accounts">,
    agentId: import("./_generated/dataModel").Id<"agents">,
) {
    const agent = (await ctx.db.get(agentId)) as
        | (typeof agentsFields & { _id: import("./_generated/dataModel").Id<"agents">; accountId: import("./_generated/dataModel").Id<"accounts"> })
        | null;
    if (!agent) {
        throw new Error(`Agent not found: ${agentId}`);
    }
    if (agent.accountId !== accountId) {
        throw new Error("Agent does not belong to the supplied accountId");
    }

    return agent;
}

/** Returns an agent only when it belongs to the supplied accountId. */
export const getById = internalQuery({
    args: {
        accountId: v.id("accounts"),
        agentId: v.id("agents"),
    },
    returns: v.union(agentDoc, v.null()),
    handler: async (ctx, args) => {
        const { accountId, agentId } = args;
        const agent = await ctx.db.get(agentId);
        if (!agent || agent.accountId !== accountId) {
            return null;
        }

        return agent;
    },
});

/** Lists every agent owned by the supplied account. */
export const list = internalQuery({
    args: { accountId: v.id("accounts") },
    returns: v.array(agentDoc),
    handler: async (ctx, args) => {
        const { accountId } = args;
        const agents = await ctx.db
            .query("agents")
            .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
            .collect();

        return agents;
    },
});

/** Creates an agent owned by the supplied account. */
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
        const {
            accountId,
            name,
            description,
            encryptedConfig,
            encryptionIv,
            encryptionTag,
        } = args;

        const account = await ctx.db.get(accountId);
        if (!account) {
            throw new Error(`Account not found: ${accountId}`);
        }

        const now = Date.now();
        const agentId = await ctx.db.insert("agents", {
            accountId: accountId,
            name: name,
            description: description,
            encryptedConfig: encryptedConfig,
            encryptionIv: encryptionIv,
            encryptionTag: encryptionTag,
            createdAt: now,
            updatedAt: now,
        });

        return agentId;
    },
});

/** Patches agent fields. Verifies the agent belongs to the supplied account. */
export const update = internalMutation({
    args: {
        accountId: v.id("accounts"),
        agentId: v.id("agents"),
        name: v.optional(v.string()),
        description: v.optional(v.string()),
        encryptedConfig: v.optional(v.string()),
        encryptionIv: v.optional(v.string()),
        encryptionTag: v.optional(v.string()),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const {
            accountId,
            agentId,
            name,
            description,
            encryptedConfig,
            encryptionIv,
            encryptionTag,
        } = args;

        await requireAccountOwnsAgent(ctx, accountId, agentId);

        await ctx.db.patch(agentId, {
            ...(name !== undefined ? { name: name } : {}),
            ...(description !== undefined ? { description: description } : {}),
            ...(encryptedConfig !== undefined
                ? { encryptedConfig: encryptedConfig }
                : {}),
            ...(encryptionIv !== undefined ? { encryptionIv: encryptionIv } : {}),
            ...(encryptionTag !== undefined ? { encryptionTag: encryptionTag } : {}),
            updatedAt: Date.now(),
        });

        return null;
    },
});

/** Removes an agent after verifying account ownership. */
export const remove = internalMutation({
    args: {
        accountId: v.id("accounts"),
        agentId: v.id("agents"),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const { accountId, agentId } = args;
        await requireAccountOwnsAgent(ctx, accountId, agentId);
        await ctx.db.delete(agentId);

        return null;
    },
});
