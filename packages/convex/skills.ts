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

/** Returns a skill only when it belongs to the supplied account. */
export const getById = internalQuery({
    args: {
        accountId: v.id("accounts"),
        skillId: v.id("skills"),
    },
    returns: v.union(skillDoc, v.null()),
    handler: async (ctx, args) => {
        const { accountId, skillId } = args;
        const skill = await ctx.db.get(skillId);
        if (!skill || skill.accountId !== accountId) {
            return null;
        }

        return skill;
    },
});

/** Lists every skill owned by the supplied account. */
export const list = internalQuery({
    args: { accountId: v.id("accounts") },
    returns: v.array(skillDoc),
    handler: async (ctx, args) => {
        const { accountId } = args;
        const skills = await ctx.db
            .query("skills")
            .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
            .collect();

        return skills;
    },
});

/** Registers a skill pointer for the supplied account. */
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
        const { accountId, name, description, s3Key, sizeBytes } = args;

        const account = await ctx.db.get(accountId);
        if (!account) {
            throw new Error(`Account not found: ${accountId}`);
        }

        const now = Date.now();
        const skillId = await ctx.db.insert("skills", {
            accountId: accountId,
            name: name,
            description: description,
            s3Key: s3Key,
            sizeBytes: sizeBytes,
            createdAt: now,
            updatedAt: now,
        });

        return skillId;
    },
});

/** Patches skill fields after verifying account ownership. */
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
    handler: async (ctx, args) => {
        const { accountId, skillId, name, description, s3Key, sizeBytes } =
            args;

        const skill = await ctx.db.get(skillId);
        if (!skill || skill.accountId !== accountId) {
            throw new Error("Skill does not belong to the supplied accountId");
        }

        await ctx.db.patch(skillId, {
            ...(name !== undefined ? { name: name } : {}),
            ...(description !== undefined ? { description: description } : {}),
            ...(s3Key !== undefined ? { s3Key: s3Key } : {}),
            ...(sizeBytes !== undefined ? { sizeBytes: sizeBytes } : {}),
            updatedAt: Date.now(),
        });

        return null;
    },
});

/** Removes a skill pointer after verifying account ownership. S3 cleanup is the caller's job. */
export const remove = internalMutation({
    args: {
        accountId: v.id("accounts"),
        skillId: v.id("skills"),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const { accountId, skillId } = args;
        const skill = await ctx.db.get(skillId);
        if (!skill || skill.accountId !== accountId) {
            return null;
        }
        await ctx.db.delete(skillId);

        return null;
    },
});
