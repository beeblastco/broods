/**
 * Workspace config CRUD scoped to an account. Mirrors sandboxConfigs.ts, but the
 * config object holds no secrets and is stored in plaintext. The doc _id is the
 * public workspaceId; every mutation revalidates ownership against the
 * caller-supplied accountId.
 */

import { v } from "convex/values";
import { paginationOptsValidator, type PaginationResult } from "convex/server";
import { internalMutation, internalQuery } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { workspaceConfigsFields, paginationCursorFields } from "../schema";

const workspaceConfigDoc = v.object({
  ...workspaceConfigsFields,
  _id: v.id("workspaceConfigs"),
  _creationTime: v.number(),
});

/**
 * Look up a workspace config by the public string id. The validator accepts
 * `v.string()` (not `v.id`) so unknown ids resolve to `null` instead of throwing.
 */
export const getById = internalQuery({
  args: {
    accountId: v.id("accounts"),
    workspaceId: v.string(),
  },
  returns: v.union(workspaceConfigDoc, v.null()),
  handler: async (ctx, args): Promise<Doc<"workspaceConfigs"> | null> => {
    const normalized = ctx.db.normalizeId("workspaceConfigs", args.workspaceId);
    if (!normalized) return null;
    const doc = await ctx.db.get(normalized);
    if (!doc || doc.accountId !== args.accountId) return null;

    return doc;
  },
});

export const list = internalQuery({
  args: { accountId: v.id("accounts") },
  returns: v.array(workspaceConfigDoc),
  handler: async (ctx, args): Promise<Doc<"workspaceConfigs">[]> => {
    return await ctx.db
      .query("workspaceConfigs")
      .withIndex("by_accountId_and_name", (q) =>
        q.eq("accountId", args.accountId),
      )
      .collect();
  },
});

export const listPage = internalQuery({
  args: {
    accountId: v.id("accounts"),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(workspaceConfigDoc),
    ...paginationCursorFields,
  }),
  handler: async (
    ctx,
    args,
  ): Promise<PaginationResult<Doc<"workspaceConfigs">>> => {
    return await ctx.db
      .query("workspaceConfigs")
      .withIndex("by_accountId_and_name", (q) =>
        q.eq("accountId", args.accountId),
      )
      .paginate(args.paginationOpts);
  },
});

export const create = internalMutation({
  args: {
    accountId: v.id("accounts"),
    name: v.string(),
    description: v.optional(v.string()),
    config: v.any(),
  },
  returns: v.id("workspaceConfigs"),
  handler: async (ctx, args): Promise<Id<"workspaceConfigs">> => {
    const account = await ctx.db.get(args.accountId);
    if (!account) {
      throw new Error(`Account not found: ${args.accountId}`);
    }

    const now = Date.now();

    return await ctx.db.insert("workspaceConfigs", {
      accountId: args.accountId,
      name: args.name,
      description: args.description,
      config: args.config,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = internalMutation({
  args: {
    accountId: v.id("accounts"),
    workspaceId: v.string(),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    config: v.optional(v.any()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { accountId, workspaceId, ...patch } = args;
    const normalized = ctx.db.normalizeId("workspaceConfigs", workspaceId);
    if (!normalized) {
      throw new Error(
        "Workspace config does not belong to the supplied accountId",
      );
    }
    const doc = await ctx.db.get(normalized);
    if (!doc || doc.accountId !== accountId) {
      throw new Error(
        "Workspace config does not belong to the supplied accountId",
      );
    }

    await ctx.db.patch(normalized, {
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.description !== undefined && {
        description: patch.description,
      }),
      ...(patch.config !== undefined && { config: patch.config }),
      updatedAt: Date.now(),
    });

    return null;
  },
});

export const remove = internalMutation({
  args: {
    accountId: v.id("accounts"),
    workspaceId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const normalized = ctx.db.normalizeId("workspaceConfigs", args.workspaceId);
    if (!normalized) {
      throw new Error(
        "Workspace config does not belong to the supplied accountId",
      );
    }
    const doc = await ctx.db.get(normalized);
    if (!doc || doc.accountId !== args.accountId) {
      throw new Error(
        "Workspace config does not belong to the supplied accountId",
      );
    }

    await ctx.db.delete(normalized);

    return null;
  },
});
