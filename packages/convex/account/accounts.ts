import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { deleteAccountContentsBatch } from "../model/cascade";
import { accountDoc } from "../model/accountDoc";

const statusValidator = v.union(v.literal("active"), v.literal("disabled"));

export const create = internalMutation({
  args: {
    orgId: v.string(),
    username: v.string(),
    description: v.optional(v.string()),
    secretHash: v.string(),
    secretHint: v.optional(v.string()),
    secretRotatedBy: v.optional(v.id("users")),
    status: v.optional(statusValidator),
  },
  returns: accountDoc,
  handler: async (ctx, args): Promise<Doc<"accounts">> => {
    const existing = await ctx.db
      .query("accounts")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .unique();
    if (existing) {
      throw new Error(`Account already exists for orgId=${args.orgId}`);
    }

    const now = Date.now();
    const accountId = await ctx.db.insert("accounts", {
      orgId: args.orgId,
      username: args.username,
      description: args.description,
      secretHash: args.secretHash,
      secretHint: args.secretHint,
      secretRotatedAt: args.secretHint ? now : undefined,
      secretRotatedBy: args.secretRotatedBy,
      status: args.status ?? "active",
      createdAt: now,
      updatedAt: now,
    });
    const account = await ctx.db.get(accountId);
    if (!account) {
      throw new Error("Failed to read created account");
    }

    return account;
  },
});

// A string, not v.id: an unissued id from a URL must answer 404, not a 500 that makes the
// webhook provider retry forever.
export const getById = internalQuery({
  args: { accountId: v.string() },
  returns: v.union(accountDoc, v.null()),
  handler: async (ctx, args): Promise<Doc<"accounts"> | null> => {
    const accountId = ctx.db.normalizeId("accounts", args.accountId);

    return accountId ? await ctx.db.get(accountId) : null;
  },
});

export const getByOrgId = internalQuery({
  args: { orgId: v.string() },
  returns: v.union(accountDoc, v.null()),
  handler: async (ctx, args): Promise<Doc<"accounts"> | null> => {
    return await ctx.db
      .query("accounts")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .unique();
  },
});

export const getBySecretHash = internalQuery({
  args: { secretHash: v.string() },
  returns: v.union(accountDoc, v.null()),
  handler: async (ctx, args): Promise<Doc<"accounts"> | null> => {
    return await ctx.db
      .query("accounts")
      .withIndex("by_secretHash", (q) => q.eq("secretHash", args.secretHash))
      .unique();
  },
});

export const list = internalQuery({
  args: {},
  returns: v.array(accountDoc),
  handler: async (ctx): Promise<Doc<"accounts">[]> => {
    return await ctx.db.query("accounts").collect();
  },
});

// One bounded batch per call, rescheduled until gone. S3 cleanup is the caller's job.
export const remove = internalMutation({
  args: { accountId: v.id("accounts") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const complete = await deleteAccountContentsBatch(ctx, args.accountId);
    if (!complete) {
      await ctx.scheduler.runAfter(0, internal.account.accounts.remove, {
        accountId: args.accountId,
      });
    }

    return null;
  },
});

export const removeBatch = internalMutation({
  args: { accountId: v.id("accounts") },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    return await deleteAccountContentsBatch(ctx, args.accountId);
  },
});

export const update = internalMutation({
  args: {
    accountId: v.id("accounts"),
    username: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
    status: v.optional(statusValidator),
    secretHash: v.optional(v.string()),
    secretHint: v.optional(v.string()),
    secretRotatedBy: v.optional(v.id("users")),
    auditRetentionDays: v.optional(v.union(v.number(), v.null())),
  },
  returns: v.union(accountDoc, v.null()),
  handler: async (ctx, args): Promise<Doc<"accounts"> | null> => {
    const { accountId, ...patch } = args;
    const account = await ctx.db.get(accountId);
    if (!account) {
      return null;
    }

    await ctx.db.patch(accountId, {
      ...(patch.username !== undefined && { username: patch.username }),
      ...(patch.description !== undefined && {
        description: patch.description ?? undefined,
      }),
      ...(patch.secretHint !== undefined && {
        secretHint: patch.secretHint,
        secretRotatedAt: Date.now(),
        secretRotatedBy: patch.secretRotatedBy,
      }),
      ...(patch.auditRetentionDays !== undefined && {
        auditRetentionDays: patch.auditRetentionDays ?? undefined,
      }),
      ...(patch.status !== undefined && { status: patch.status }),
      ...(patch.secretHash !== undefined && { secretHash: patch.secretHash }),
      updatedAt: Date.now(),
    });

    return await ctx.db.get(accountId);
  },
});
