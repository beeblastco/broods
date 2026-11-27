// The config blob is plaintext: bindings and policy ids, never credentials.

import { v } from "convex/values";
import { paginationOptsValidator, type PaginationResult } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { channelRecordsFields, paginationCursorFields } from "../schema";
import { ClientError } from "../model/clientError";

const channelRecordDoc = v.object({
  ...channelRecordsFields,
  _id: v.id("channelRecords"),
  _creationTime: v.number(),
});

export const create = internalMutation({
  args: {
    accountId: v.id("accounts"),
    platform: v.string(),
    externalId: v.string(),
    workspaceRef: v.optional(v.string()),
    name: v.string(),
    description: v.optional(v.string()),
    config: v.any(),
  },
  returns: v.id("channelRecords"),
  handler: async (ctx, args): Promise<Id<"channelRecords">> => {
    const account = await ctx.db.get(args.accountId);
    if (!account) {
      throw new Error(`Account not found: ${args.accountId}`);
    }
    // One active record per place, so the webhook lookup stays unambiguous.
    const existing = await ctx.db
      .query("channelRecords")
      .withIndex("by_accountId_platform_external", (q) =>
        q
          .eq("accountId", args.accountId)
          .eq("platform", args.platform)
          .eq("externalId", args.externalId)
          .eq("status", "active"),
      )
      .first();
    if (existing) {
      throw new ClientError(
        `A channel record already exists for ${args.platform}:${args.externalId}`,
        "conflict",
      );
    }

    const now = Date.now();

    return await ctx.db.insert("channelRecords", {
      accountId: args.accountId,
      platform: args.platform,
      externalId: args.externalId,
      workspaceRef: args.workspaceRef,
      name: args.name,
      description: args.description,
      config: args.config,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const getByExternalId = internalQuery({
  args: {
    accountId: v.id("accounts"),
    platform: v.string(),
    externalId: v.string(),
  },
  returns: v.union(channelRecordDoc, v.null()),
  handler: async (ctx, args): Promise<Doc<"channelRecords"> | null> => {
    // status in the index key, not a filter: every inbound message runs this, and a
    // rebound place keeps its tombstones.
    return await ctx.db
      .query("channelRecords")
      .withIndex("by_accountId_platform_external", (q) =>
        q
          .eq("accountId", args.accountId)
          .eq("platform", args.platform)
          .eq("externalId", args.externalId)
          .eq("status", "active"),
      )
      .first();
  },
});

// v.string(), not v.id: a foreign id resolves to null instead of throwing at the adapter.
export const getById = internalQuery({
  args: {
    accountId: v.id("accounts"),
    channelRecordId: v.string(),
  },
  returns: v.union(channelRecordDoc, v.null()),
  handler: async (ctx, args): Promise<Doc<"channelRecords"> | null> => {
    const normalized = ctx.db.normalizeId(
      "channelRecords",
      args.channelRecordId,
    );
    if (!normalized) return null;
    const doc = await ctx.db.get(normalized);
    if (!doc || doc.accountId !== args.accountId) return null;

    return doc;
  },
});

// Includes tombstones: core's removeAllForAccount must see the dead rows.
export const list = internalQuery({
  args: { accountId: v.id("accounts") },
  returns: v.array(channelRecordDoc),
  handler: async (ctx, args): Promise<Doc<"channelRecords">[]> => {
    return await ctx.db
      .query("channelRecords")
      .withIndex("by_accountId_and_status", (q) =>
        q.eq("accountId", args.accountId),
      )
      .collect();
  },
});

export const listActive = internalQuery({
  args: { accountId: v.id("accounts") },
  returns: v.array(channelRecordDoc),
  handler: async (ctx, args): Promise<Doc<"channelRecords">[]> => {
    return await ctx.db
      .query("channelRecords")
      .withIndex("by_accountId_and_status", (q) =>
        q.eq("accountId", args.accountId).eq("status", "active"),
      )
      .collect();
  },
});

export const listActivePage = internalQuery({
  args: {
    accountId: v.id("accounts"),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(channelRecordDoc),
    ...paginationCursorFields,
  }),
  handler: async (
    ctx,
    args,
  ): Promise<PaginationResult<Doc<"channelRecords">>> => {
    return await ctx.db
      .query("channelRecords")
      .withIndex("by_accountId_and_status", (q) =>
        q.eq("accountId", args.accountId).eq("status", "active"),
      )
      .paginate(args.paginationOpts);
  },
});

export const remove = internalMutation({
  args: {
    accountId: v.id("accounts"),
    channelRecordId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const doc = await loadOwnedRecord(
      ctx,
      args.accountId,
      args.channelRecordId,
    );
    await ctx.db.delete(doc._id);

    return null;
  },
});

export const update = internalMutation({
  args: {
    accountId: v.id("accounts"),
    channelRecordId: v.string(),
    name: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
    workspaceRef: v.optional(v.union(v.string(), v.null())),
    config: v.optional(v.any()),
    status: v.optional(v.union(v.literal("active"), v.literal("deleted"))),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { accountId, channelRecordId, ...patch } = args;
    const doc = await loadOwnedRecord(ctx, accountId, channelRecordId);
    // Re-check create's one-active-row invariant, or getByExternalId picks an arbitrary row.
    if (patch.status === "active" && doc.status !== "active") {
      const active = (
        await ctx.db
          .query("channelRecords")
          .withIndex("by_accountId_platform_external", (q) =>
            q
              .eq("accountId", accountId)
              .eq("platform", doc.platform)
              .eq("externalId", doc.externalId)
              .eq("status", "active"),
          )
          .take(2)
      ).find((row) => row._id !== doc._id);
      if (active) {
        throw new ClientError(
          `A channel record already exists for ${doc.platform}:${doc.externalId}`,
          "conflict",
        );
      }
    }

    await ctx.db.patch(doc._id, {
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.description !== undefined && {
        description: patch.description ?? undefined,
      }),
      ...(patch.workspaceRef !== undefined && {
        workspaceRef: patch.workspaceRef ?? undefined,
      }),
      ...(patch.config !== undefined && { config: patch.config }),
      ...(patch.status !== undefined && { status: patch.status }),
      ...(patch.status === "deleted" && { deletedAt: Date.now() }),
      ...(patch.status === "active" && { deletedAt: undefined }),
      updatedAt: Date.now(),
    });

    return null;
  },
});

async function loadOwnedRecord(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  channelRecordId: string,
): Promise<Doc<"channelRecords">> {
  const normalized = ctx.db.normalizeId("channelRecords", channelRecordId);
  if (!normalized) {
    throw new ClientError(
      "Channel record does not belong to the supplied accountId",
    );
  }
  const doc = await ctx.db.get(normalized);
  if (!doc || doc.accountId !== accountId) {
    throw new ClientError(
      "Channel record does not belong to the supplied accountId",
    );
  }

  return doc;
}
