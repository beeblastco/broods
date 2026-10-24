/**
 * Writes the rates `modelPrices/crawl.ts` crawls, one doc per agent provider.
 */

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { stableJson } from "../model/objects";
import { modelPricesFields } from "../schema";

/** Crawl: replace each provider's rates, writing only the ones that changed. */
export const store = internalMutation({
  args: { providers: v.array(v.object(modelPricesFields)) },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const { provider, models } of args.providers) {
      const existing = await ctx.db
        .query("modelPrices")
        .withIndex("by_provider", (q) => q.eq("provider", provider))
        .unique();
      if (!existing) {
        await ctx.db.insert("modelPrices", {
          provider: provider,
          models: models,
        });
      } else if (stableJson(existing.models) !== stableJson(models)) {
        await ctx.db.patch(existing._id, { models: models });
      }
    }

    return null;
  },
});
