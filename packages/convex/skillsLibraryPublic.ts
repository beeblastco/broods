/**
 * Dashboard-facing read of the account's skill library. `skillsPublic.ts`
 * holds the bearer-token actions used by upload/import flows; this file is
 * the WorkOS-identity query surface the agent panel uses to show the library
 * truthfully (ticket 16's read-only Skills tab; ticket 17 builds on it).
 */

import { v } from "convex/values";
import { query } from "./_generated/server";
import { authKit } from "./auth";
import { getActiveAccountForUser } from "./org";
import { skillsFields } from "./schema";

const skillRow = v.object({
  ...skillsFields,
  _id: v.id("skills"),
  _creationTime: v.number(),
});

export const list = query({
  args: {},
  returns: v.array(skillRow),
  handler: async (ctx) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const account = await getActiveAccountForUser(ctx);
    if (!account) return [];

    return await ctx.db
      .query("skills")
      .withIndex("by_accountId", (q) => q.eq("accountId", account._id))
      .collect();
  },
});
