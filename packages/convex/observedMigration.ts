/**
 * One-time strip of the dead `observed` flag from the async result rows, so
 * the schema can drop the field: Convex refuses a schema push that stored
 * documents do not match, and a row's expiry moves forward with every write.
 * Run it once per deployment after this release deploys:
 * `npx convex run observedMigration:stripObserved`
 * It schedules itself until no row carries the flag; a run that returns 0
 * confirms it is done. Delete this file with the schema field and its
 * `by_observed` indexes.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

// Rows carry whole results, up to 1 MiB each: a small batch per table stays
// under one mutation's read limit.
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
