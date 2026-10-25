/**
 * Writes what `modelPrices/crawl.ts` gathers: the catalogue's rates into
 * `modelPrices` and the org's `BROODS_MODEL_PRICES` into `modelPriceOverrides`,
 * one doc per agent provider, writing only the ones that changed.
 */

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { stableJson } from "../model/objects";
import { modelPriceOverridesFields, modelPricesFields } from "../schema";

/**
 * Crawl: the catalogue's rates. A provider the catalogue stops listing keeps
 * its last rates; `clear` drops every one, for when no catalogue is set.
 */
export const storeCatalogue = internalMutation({
  args: {
    providers: v.array(v.object(modelPricesFields)),
    clear: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const stored = await ctx.db.query("modelPrices").collect();
    const next = new Map(
      args.providers.map((rates) => [rates.provider, rates]),
    );
    for (const doc of stored) {
      const rates = next.get(doc.provider);
      next.delete(doc.provider);
      if (args.clear) await ctx.db.delete(doc._id);
      else if (rates && stableJson(doc.models) !== stableJson(rates.models)) {
        await ctx.db.patch(doc._id, { models: rates.models });
      }
    }
    for (const rates of next.values()) {
      await ctx.db.insert("modelPrices", rates);
    }

    return null;
  },
});

/** Crawl: mirror the org's `BROODS_MODEL_PRICES`, so a removed rate goes. */
export const storeOverrides = internalMutation({
  args: { providers: v.array(v.object(modelPriceOverridesFields)) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const stored = await ctx.db.query("modelPriceOverrides").collect();
    const next = new Map(
      args.providers.map((rates) => [rates.provider, rates]),
    );
    for (const doc of stored) {
      const rates = next.get(doc.provider);
      next.delete(doc.provider);
      if (!rates) await ctx.db.delete(doc._id);
      else if (stableJson(doc.models) !== stableJson(rates.models)) {
        await ctx.db.patch(doc._id, { models: rates.models });
      }
    }
    for (const rates of next.values()) {
      await ctx.db.insert("modelPriceOverrides", rates);
    }

    return null;
  },
});
