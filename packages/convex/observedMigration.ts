/**
 * One-time strip of the dead `observed` flag from the async result rows, so
 * the schema can drop the field: Convex refuses a schema push that stored
 * documents do not match. `crons.ts` runs it every 10 minutes on each
 * deployment, so a stage is clean minutes after this release reaches it.
 * Delete this file, its cron, the field and its `by_observed` indexes together.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

// Rows carry whole results, up to 1 MiB each, and a patch rewrites the whole
// row: 4 per table keeps a mutation at 8 MiB read and written, half of
// Convex's 16 MiB per-transaction limits.
const BATCH_SIZE = 4;
const TABLES = ["runtimeAsyncAgentResults", "runtimeAsyncToolResults"] as const;

/**
 * Unsets `observed` on a batch of each table's flagged rows, read through
 * `by_observed` (a set flag sorts after every unset one), and schedules
 * itself again while a table filled its batch.
 * @returns how many rows this batch unset
 */
export const stripObserved = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx): Promise<number> => {
    let stripped = 0;
    let more = false;
    for (const table of TABLES) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_observed", (q) => q.gte("observed", false))
        .take(BATCH_SIZE);
      for (const row of rows) {
        await ctx.db.patch(row._id, { observed: undefined });
      }
      stripped += rows.length;
      more ||= rows.length === BATCH_SIZE;
    }
    if (more) {
      await ctx.scheduler.runAfter(
        0,
        internal.observedMigration.stripObserved,
        {},
      );
    }

    return stripped;
  },
});
