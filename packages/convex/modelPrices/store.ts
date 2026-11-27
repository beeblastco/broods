import type { WithoutSystemFields } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { stableJson } from "../model/objects";
import { modelPriceOverridesFields, modelPricesFields } from "../schema";

type PriceTable = "modelPrices" | "modelPriceOverrides";

// A provider the catalogue stops listing keeps its last rates unless `mirror`.
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

export const storeOverrides = internalMutation({
  args: { providers: v.array(v.object(modelPriceOverridesFields)) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await syncProviders(ctx, "modelPriceOverrides", args.providers, true);

    return null;
  },
});

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
