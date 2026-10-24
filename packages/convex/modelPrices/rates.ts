/**
 * Model token rates crawled from models.dev: the crawl stores them per source,
 * the dashboard reads the ones for the models its usage names.
 */

import { v } from "convex/values";
import { internalMutation, query } from "../_generated/server";
import { authKit } from "../auth";
import { MODELS_DEV_SOURCES } from "../model/modelPricing";
import { isAccountModelProviderName } from "../model/modelProviders";
import { modelPricesFields } from "../schema";

const modelRef = v.object({ modelProvider: v.string(), modelId: v.string() });

/** Dashboard: the rates of each listed model that has a public price. */
export const forModels = query({
  args: { models: v.array(modelRef) },
  returns: v.array(
    v.object({
      modelProvider: v.string(),
      modelId: v.string(),
      input: v.number(),
      output: v.number(),
      cacheRead: v.number(),
      cacheWrite: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    // Several providers can share a source (`openai` and `chatgpt`), so each
    // lowercased id keeps every model that names it.
    const sources = new Map<
      string,
      Map<string, Array<(typeof args.models)[number]>>
    >();
    for (const model of args.models) {
      if (!isAccountModelProviderName(model.modelProvider)) continue;
      const source = MODELS_DEV_SOURCES[model.modelProvider];
      if (source === null) continue;
      const wanted = sources.get(source) ?? new Map();
      const modelId = model.modelId.toLowerCase();
      wanted.set(modelId, [...(wanted.get(modelId) ?? []), model]);
      sources.set(source, wanted);
    }
    const priced = await Promise.all(
      [...sources].map(async ([source, wanted]) => {
        const doc = await ctx.db
          .query("modelPrices")
          .withIndex("by_source", (q) => q.eq("source", source))
          .unique();

        return (doc?.models ?? []).flatMap(({ modelId, ...rates }) =>
          (wanted.get(modelId) ?? []).map((model) => ({ ...model, ...rates })),
        );
      }),
    );

    return priced.flat();
  },
});

/** Crawl: replace each source's rates, writing only the ones that changed. */
export const store = internalMutation({
  args: {
    sources: v.array(
      v.object({
        source: modelPricesFields.source,
        models: modelPricesFields.models,
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const { source, models } of args.sources) {
      const existing = await ctx.db
        .query("modelPrices")
        .withIndex("by_source", (q) => q.eq("source", source))
        .unique();
      if (!existing) {
        await ctx.db.insert("modelPrices", {
          source: source,
          models: models,
          updatedAt: now,
        });
      } else if (JSON.stringify(existing.models) !== JSON.stringify(models)) {
        await ctx.db.patch(existing._id, { models: models, updatedAt: now });
      }
    }

    return null;
  },
});
