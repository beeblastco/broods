/**
 * Writes the rates `modelPrices/crawl.ts` gathers, one doc per agent
 * provider, and the crawl's inputs so the next run can fetch conditionally.
 */

import { v, type Infer } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import type { ModelTokenRates } from "../model/modelPricing";
import type { ProviderRates } from "../model/modelsDev";
import { stableJson } from "../model/objects";
import { modelPriceCrawlFields, modelPricesFields } from "../schema";

const crawlInputs = v.object(modelPriceCrawlFields);
const providerRates = v.array(v.object(modelPricesFields));

type RateRow = ModelTokenRates & { modelId: string };

/**
 * Crawl: the last run's catalogue URL, ETag and inline prices. Null before
 * the first run and while no rate is stored, so an emptied table is refilled
 * instead of trusting a 304.
 */
export const crawlState = internalQuery({
  args: {},
  returns: v.union(crawlInputs, v.null()),
  handler: async (ctx): Promise<Infer<typeof crawlInputs> | null> => {
    const row = await ctx.db.query("modelPriceCrawl").first();
    const priced = await ctx.db.query("modelPrices").first();

    return row && priced
      ? { url: row.url, etag: row.etag, inline: row.inline }
      : null;
  },
});

/**
 * Crawl: replace each provider's rates, writing only the ones that changed.
 * The org's inline prices apply over the crawl. The table mirrors the inputs:
 * a provider in neither loses its rates.
 */
export const store = internalMutation({
  args: { crawled: providerRates, inline: providerRates, crawl: crawlInputs },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const stored = new Map(
      (await ctx.db.query("modelPrices").collect()).map((doc) => [
        doc.provider,
        doc,
      ]),
    );
    const providers = new Set([
      ...args.crawled.map((rates) => rates.provider),
      ...args.inline.map((rates) => rates.provider),
      ...stored.keys(),
    ]);
    for (const provider of providers) {
      const existing = stored.get(provider);
      const models = new Map<string, RateRow>();
      for (const row of [
        ...ratesOf(args.crawled, provider),
        ...ratesOf(args.inline, provider),
      ]) {
        models.set(row.modelId, row);
      }
      const next = [...models.values()];
      if (next.length === 0) {
        if (existing) await ctx.db.delete(existing._id);
      } else if (!existing) {
        await ctx.db.insert("modelPrices", {
          provider: provider,
          models: next,
        });
      } else if (stableJson(existing.models) !== stableJson(next)) {
        await ctx.db.patch(existing._id, { models: next });
      }
    }

    const state = await ctx.db.query("modelPriceCrawl").first();
    if (!state) {
      await ctx.db.insert("modelPriceCrawl", args.crawl);
    } else if (
      stableJson({ url: state.url, etag: state.etag, inline: state.inline }) !==
      stableJson(args.crawl)
    ) {
      await ctx.db.patch(state._id, args.crawl);
    }

    return null;
  },
});

/** One provider's rows in a list of provider rates. */
function ratesOf(rates: ProviderRates[], provider: string): RateRow[] {
  return rates.find((entry) => entry.provider === provider)?.models ?? [];
}
