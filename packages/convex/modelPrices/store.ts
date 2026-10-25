/**
 * Writes what `modelPrices/crawl.ts` gathers: the catalogue's rates into
 * `modelPrices` and the org's `BROODS_MODEL_PRICES` into `modelPriceOverrides`,
 * one doc per agent provider, writing only the ones that changed.
 */

import type { WithoutSystemFields } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { stableJson } from "../model/objects";
import { modelPriceOverridesFields, modelPricesFields } from "../schema";

type PriceTable = "modelPrices" | "modelPriceOverrides";

/**
 * Crawl: the catalogue's rates. A provider the catalogue stops listing keeps
 * its last rates unless `mirror`, which the crawl sets with no catalogue to
 * clear them.
 */
export const storeCatalogue = internalMutation({
  args: {
    providers: v.array(v.object(modelPricesFields)),
    mirror: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await syncProviders(ctx, "modelPrices", args.providers, args.mirror);

    return null;
  },
});

/** Crawl: mirror the org's `BROODS_MODEL_PRICES`, so a removed rate goes. */
export const storeOverrides = internalMutation({
  args: { providers: v.array(v.object(modelPriceOverridesFields)) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await syncProviders(ctx, "modelPriceOverrides", args.providers, true);

    return null;
  },
});

/** Insert, patch or (when `mirror`) delete one doc per provider, skipping unchanged ones. */
async function syncProviders<Table extends PriceTable>(
  ctx: MutationCtx,
  table: Table,
  providers: Array<WithoutSystemFields<Doc<Table>>>,
  mirror: boolean,
): Promise<void> {
  const next = new Map(providers.map((rates) => [rates.provider, rates]));
  for (const doc of await ctx.db.query(table).collect()) {
    const rates = next.get(doc.provider);
    next.delete(doc.provider);
    if (!rates) {
      if (mirror) await ctx.db.delete(doc._id);
    } else if (stableJson(doc.models) !== stableJson(rates.models)) {
      await ctx.db.patch(doc._id, { models: rates.models });
    }
  }
  for (const rates of next.values()) {
    await ctx.db.insert(table, rates);
  }
}
