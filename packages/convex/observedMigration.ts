/**
 * One-time strip of the dead `observed` flag from the async result rows, so
 * the schema can drop the field: Convex refuses a schema push that stored
 * documents do not match, and a row's expiry moves forward with every write.
 * Run it once per deployment after this release deploys:
 * `npx convex run observedMigration:stripObserved`
 * It pages through both tables on its own. Delete this file with the schema
 * field; that push fails if any row still carries the flag.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

// Rows carry whole results; a small page stays far under the read limit.
const PAGE_SIZE = 50;

/**
 * Unsets `observed` on one page of `table`, then schedules the next page:
 * the agent table first, the tool table after its last page.
 * @returns how many rows this page unset
 */
export const stripObserved = internalMutation({
  args: {
    table: v.optional(
      v.union(
        v.literal("runtimeAsyncAgentResults"),
        v.literal("runtimeAsyncToolResults"),
      ),
    ),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    const table = args.table ?? "runtimeAsyncAgentResults";
    const result = await ctx.db
      .query(table)
      .paginate({ cursor: args.cursor ?? null, numItems: PAGE_SIZE });
    const rows = result.page.filter(
      (row): boolean => row.observed !== undefined,
    );
    for (const row of rows) {
      await ctx.db.patch(row._id, { observed: undefined });
    }
    const next = !result.isDone
      ? { table: table, cursor: result.continueCursor }
      : table === "runtimeAsyncAgentResults"
        ? { table: "runtimeAsyncToolResults" as const, cursor: null }
        : null;
    if (next) {
      await ctx.scheduler.runAfter(
        0,
        internal.observedMigration.stripObserved,
        next,
      );
    }

    return rows.length;
  },
});
