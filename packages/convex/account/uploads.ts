/**
 * Upload URL minting for the HTTP routes and orphan cleanup for `crons.ts`.
 * The dashboard mutation in `workspace/files.ts` calls the model helper.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import { grantUpload } from "../model/uploads";

const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const ORPHAN_SCAN_PAGE = 100;

export const grant = internalMutation({
  args: {
    accountId: v.id("accounts"),
    kind: v.union(v.literal("mcp"), v.literal("workspace")),
  },
  returns: v.union(
    v.object({ uploadUrl: v.string() }),
    v.object({ retryAt: v.number() }),
  ),
  handler: async (ctx, args) =>
    await grantUpload(ctx, args.accountId, args.kind),
});

/**
 * Delete blobs older than a day that no workspace file references, one page
 * per invocation, oldest first, rescheduling itself up to the age cutoff.
 */
export const pruneOrphans = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ deleted: v.number(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    const cutoff = Date.now() - ORPHAN_MIN_AGE_MS;
    const page = await ctx.db.system
      .query("_storage")
      .order("asc")
      .paginate({ cursor: args.cursor ?? null, numItems: ORPHAN_SCAN_PAGE });

    let deleted = 0;
    let reachedCutoff = false;
    for (const blob of page.page) {
      if (blob._creationTime >= cutoff) {
        reachedCutoff = true;
        break;
      }
      const referenced = await ctx.db
        .query("workspaceFiles")
        .withIndex("by_storageId", (q) => q.eq("storageId", blob._id))
        .first();
      if (referenced) continue;
      await ctx.storage.delete(blob._id);
      deleted += 1;
    }

    const isDone = page.isDone || reachedCutoff;
    if (!isDone) {
      await ctx.scheduler.runAfter(0, internal.account.uploads.pruneOrphans, {
        cursor: page.continueCursor,
      });
    }

    return { deleted: deleted, isDone: isDone };
  },
});
