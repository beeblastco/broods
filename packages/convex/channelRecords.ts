/**
 * Channel record CRUD scoped to an account. Mirrors sandboxConfigs.ts: the doc
 * _id is the public channelRecordId and every mutation revalidates the doc's
 * accountId. `getByExternalId` is the inbound-webhook lookup — it answers
 * "which record owns this Slack channel?" before an agent is chosen.
 * The config blob is plaintext: bindings and policy ids, never credentials.
 */

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { channelRecordsFields } from "./schema";

const channelRecordDoc = v.object({
  ...channelRecordsFields,
  _id: v.id("channelRecords"),
  _creationTime: v.number(),
});

/**
 * Look up a channel record by the public string id. The validator accepts
 * `v.string()` (not `v.id`) so unknown / non-Convex-id values resolve to `null`
 * (= "not found") instead of throwing at the adapter boundary.
 */
export const getById = internalQuery({
  args: {
    accountId: v.id("accounts"),
    channelRecordId: v.string(),
  },
  returns: v.union(channelRecordDoc, v.null()),
  handler: async (ctx, args) => {
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

/**
 * Resolve the active record for one place. Deleted rows never match, so a
 * removed record falls the webhook back to its agent-scoped behaviour instead
 * of routing to an agent the operator has detached.
 */
export const getByExternalId = internalQuery({
  args: {
    accountId: v.id("accounts"),
    platform: v.string(),
    externalId: v.string(),
  },
  returns: v.union(channelRecordDoc, v.null()),
  handler: async (ctx, args) => {
    // Deleting a record leaves the row in place, and creating a replacement is
    // then allowed — so this place can hold a deleted row *and* an active one.
    // `.first()` would hand back whichever the index reaches first and resolve
    // to null; pick the active row explicitly.
    const docs = await ctx.db
      .query("channelRecords")
      .withIndex("by_accountId_platform_external", (q) =>
        q
          .eq("accountId", args.accountId)
          .eq("platform", args.platform)
          .eq("externalId", args.externalId),
      )
      .collect();

    return docs.find((doc) => doc.status === "active") ?? null;
  },
});

export const list = internalQuery({
  args: { accountId: v.id("accounts") },
  returns: v.array(channelRecordDoc),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("channelRecords")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();
  },
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
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) {
      throw new Error(`Account not found: ${args.accountId}`);
    }
    // One active record per place, so the webhook lookup stays unambiguous.
    const existing = (
      await ctx.db
        .query("channelRecords")
        .withIndex("by_accountId_platform_external", (q) =>
          q
            .eq("accountId", args.accountId)
            .eq("platform", args.platform)
            .eq("externalId", args.externalId),
        )
        .collect()
    ).find((doc) => doc.status === "active");
    if (existing) {
      throw new Error(
        `A channel record already exists for ${args.platform}:${args.externalId}`,
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
  handler: async (ctx, args) => {
    const { accountId, channelRecordId, ...patch } = args;
    const doc = await loadOwnedRecord(ctx, accountId, channelRecordId);

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
      updatedAt: Date.now(),
    });

    return null;
  },
});

export const remove = internalMutation({
  args: {
    accountId: v.id("accounts"),
    channelRecordId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const doc = await loadOwnedRecord(
      ctx,
      args.accountId,
      args.channelRecordId,
    );
    await ctx.db.delete(doc._id);
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
    throw new Error("Channel record does not belong to the supplied accountId");
  }
  const doc = await ctx.db.get(normalized);
  if (!doc || doc.accountId !== accountId) {
    throw new Error("Channel record does not belong to the supplied accountId");
  }

  return doc;
}
