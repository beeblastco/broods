"use node";

/**
 * Hourly crawl of models.dev's model rates into `modelPrices`. Node runtime
 * because the whole catalogue is one ~6 MB JSON document, past what the
 * default runtime's memory parses comfortably.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import {
  MODELS_DEV_API_URL,
  parseModelsDevRates,
  type ModelsDevApi,
} from "../model/modelsDev";

const FETCH_TIMEOUT_MS = 30_000;

/** Cron: fetch every provider's rates and store the ones that changed. */
export const run = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const response = await fetch(MODELS_DEV_API_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`models.dev answered ${response.status}`);
    }
    const body: ModelsDevApi = await response.json();
    const providers = parseModelsDevRates(body);
    if (providers.length === 0) {
      throw new Error("models.dev returned no priced models");
    }
    await ctx.runMutation(internal.modelPrices.store.store, {
      providers: providers,
    });

    return null;
  },
});
