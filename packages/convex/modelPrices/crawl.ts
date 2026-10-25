"use node";

/**
 * Hourly crawl of model rates: the org's own `BROODS_MODEL_PRICES` into
 * `modelPriceOverrides`, then the models.dev catalogue (or
 * `BROODS_MODEL_PRICES_URL`) into `modelPrices`. A self-hosted deployment
 * fetches no catalogue unless it sets the URL, since most cannot reach the
 * internet. Node runtime because the catalogue is one ~6 MB JSON document,
 * past what the default runtime's memory parses comfortably.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, type ActionCtx } from "../_generated/server";
import {
  MODELS_DEV_API_URL,
  parseInlinePrices,
  parseModelsDevRates,
  type ModelsDevApi,
} from "../model/modelsDev";
import { authProvider } from "../model/selfHostAuth";
import { readCapped } from "../model/skills";

const FETCH_TIMEOUT_MS = 30_000;
// models.dev is ~6 MB; anything far past that is not a price catalogue.
const MAX_CATALOGUE_BYTES = 32 * 1024 * 1024;

/**
 * Cron: store the org's rates first, so a catalogue that is down never holds
 * them back, then the catalogue's. A malformed `BROODS_MODEL_PRICES` fails
 * the run only after the catalogue is stored, so it never holds that back.
 */
export const run = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    let inlineError: unknown = null;
    try {
      await ctx.runMutation(internal.modelPrices.store.storeOverrides, {
        providers: parseInlinePrices(process.env.BROODS_MODEL_PRICES ?? ""),
      });
    } catch (error) {
      inlineError = error;
    }
    await storeCatalogue(ctx);
    if (inlineError !== null) throw inlineError;

    return null;
  },
});

/** The catalogue to fetch, or "" for none: models.dev on the managed cloud, only an explicit URL when self-hosted. */
function catalogueUrl(): string {
  const configured = process.env.BROODS_MODEL_PRICES_URL ?? "";
  if (configured !== "") return configured;

  return authProvider() === "self-host" ? "" : MODELS_DEV_API_URL;
}

/** The catalogue's rates into `modelPrices`, cleared when no catalogue is set. */
async function storeCatalogue(ctx: ActionCtx): Promise<void> {
  const url = catalogueUrl();
  if (url === "") {
    await ctx.runMutation(internal.modelPrices.store.storeCatalogue, {
      providers: [],
      mirror: true,
    });

    return;
  }
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    throw new Error(`${url} answered ${response.status}`);
  }
  const body: ModelsDevApi = JSON.parse(
    Buffer.from(await readCapped(response.body, MAX_CATALOGUE_BYTES)).toString(
      "utf8",
    ),
  );
  const providers = parseModelsDevRates(body);
  if (providers.length === 0) {
    throw new Error(`${url} returned no priced models`);
  }
  await ctx.runMutation(internal.modelPrices.store.storeCatalogue, {
    providers: providers,
    mirror: false,
  });
}
