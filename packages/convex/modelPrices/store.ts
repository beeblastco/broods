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

// A crawled rate that moves further than this between runs is held back.
const MAX_RATE_JUMP = 10;
const RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

const crawlInputs = v.object(modelPriceCrawlFields);
const providerRates = v.array(v.object(modelPricesFields));

type RateRow = ModelTokenRates & { modelId: string };

/** Crawl: the last run's catalogue URL, ETag and inline prices, or null before the first. */
export const crawlState = internalQuery({
  args: {},
  returns: v.union(crawlInputs, v.null()),
  handler: async (ctx): Promise<Infer<typeof crawlInputs> | null> => {
    const row = await ctx.db.query("modelPriceCrawl").first();

    return row ? { url: row.url, etag: row.etag, inline: row.inline } : null;
  },
});

/**
 * Crawl: replace each provider's rates, writing only the ones that changed.
 * A crawled rate that moved more than 10x keeps its stored value and logs, so
 * a broken or tampered catalogue cannot swing costs; the org's inline prices
 * apply over the crawl as given. The table mirrors the inputs: a provider in
 * neither the crawl nor the inline prices loses its rates.
 */
export const store = internalMutation({
  args: { crawled: providerRates, inline: providerRates, crawl: crawlInputs },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const state = await ctx.db.query("modelPriceCrawl").first();
    const stale = await ctx.db.query("modelPrices").collect();
    const providers = new Set(
      [...args.crawled, ...args.inline, ...stale].map(
        (rates) => rates.provider,
      ),
    );
    for (const provider of providers) {
      const existing = await ctx.db
        .query("modelPrices")
        .withIndex("by_provider", (q) => q.eq("provider", provider))
        .unique();
      const stored = new Map(existing?.models.map((row) => [row.modelId, row]));
      const models = new Map<string, RateRow>();
      for (const row of ratesOf(args.crawled, provider)) {
        const old = stored.get(row.modelId);
        if (
          old &&
          RATE_KEYS.some((key) => jump(old[key], row[key]) > MAX_RATE_JUMP)
        ) {
          console.warn(
            `modelPrices: ${provider}/${row.modelId} moved over ${MAX_RATE_JUMP}x, kept the stored rate. Set BROODS_MODEL_PRICES to accept it.`,
          );
          models.set(row.modelId, old);
        } else {
          models.set(row.modelId, row);
        }
      }
      for (const row of ratesOf(args.inline, provider)) {
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

/** How many times apart two rates are; 1 when either is free, since a free preview turning paid is normal. */
function jump(before: number, after: number): number {
  return before > 0 && after > 0
    ? Math.max(before, after) / Math.min(before, after)
    : 1;
}

/** One provider's rows in a list of provider rates. */
function ratesOf(rates: ProviderRates[], provider: string): RateRow[] {
  return rates.find((entry) => entry.provider === provider)?.models ?? [];
}
