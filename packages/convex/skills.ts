/**
 * Skill metadata CRUD. Skill blobs live in S3 under accountId-prefixed keys;
 * this table only stores pointers and human-readable info.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { skillsFields } from "./schema";

const skillDoc = v.object({
    ...skillsFields,
    _id: v.id("skills"),
    _creationTime: v.number(),
});

export const getById = internalQuery({
    args: {
        accountId: v.id("accounts"),
        skillId: v.id("skills"),
    },
    returns: v.union(skillDoc, v.null()),
    handler: async (ctx, { accountId, skillId }) => {
        const skill = await ctx.db.get(skillId);
        return skill && skill.accountId === accountId ? skill : null;
    },
});

export const list = internalQuery({
    args: { accountId: v.id("accounts") },
    returns: v.array(skillDoc),
    handler: (ctx, { accountId }) =>
        ctx.db
            .query("skills")
            .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
            .collect(),
});

export const create = internalMutation({
    args: {
        accountId: v.id("accounts"),
        name: v.string(),
        description: v.optional(v.string()),
        s3Key: v.string(),
        sizeBytes: v.optional(v.number()),
    },
    returns: v.id("skills"),
    handler: async (ctx, args) => {
        const account = await ctx.db.get(args.accountId);
        if (!account) throw new Error(`Account not found: ${args.accountId}`);

        const now = Date.now();
        return ctx.db.insert("skills", {
            ...args,
            createdAt: now,
            updatedAt: now,
        });
    },
});

export const update = internalMutation({
    args: {
        accountId: v.id("accounts"),
        skillId: v.id("skills"),
        name: v.optional(v.string()),
        description: v.optional(v.string()),
        s3Key: v.optional(v.string()),
        sizeBytes: v.optional(v.number()),
    },
    returns: v.null(),
    handler: async (ctx, { accountId, skillId, ...updates }) => {
        const skill = await ctx.db.get(skillId);
        if (!skill || skill.accountId !== accountId) {
            throw new Error("Skill does not belong to the supplied accountId");
        }

        const patch = Object.fromEntries(
            Object.entries(updates).filter(([, v]) => v !== undefined),
        );
        await ctx.db.patch(skillId, { ...patch, updatedAt: Date.now() });
        return null;
    },
});

/** S3 cleanup is the caller's job. */
export const remove = internalMutation({
    args: {
        accountId: v.id("accounts"),
        skillId: v.id("skills"),
    },
    returns: v.null(),
    handler: async (ctx, { accountId, skillId }) => {
        const skill = await ctx.db.get(skillId);
        if (skill && skill.accountId === accountId) {
            await ctx.db.delete(skillId);
        }
        return null;
    },
});
