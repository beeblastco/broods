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
import { internalAction } from "../_generated/server";
import {
  MODELS_DEV_API_URL,
  parseInlinePrices,
  parseModelsDevRates,
  type ModelsDevApi,
} from "../model/modelsDev";
import { authProvider } from "../model/selfHostAuth";

const FETCH_TIMEOUT_MS = 30_000;
// models.dev is ~6 MB; anything far past that is not a price catalogue.
const MAX_CATALOGUE_BYTES = 32 * 1024 * 1024;

/**
 * Cron: store the org's rates first, so a catalogue that is down never holds
 * them back, then the catalogue's.
 */
export const run = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    await ctx.runMutation(internal.modelPrices.store.storeOverrides, {
      providers: parseInlinePrices(process.env.BROODS_MODEL_PRICES ?? ""),
    });

    const url = catalogueUrl();
    if (url === "") {
      await ctx.runMutation(internal.modelPrices.store.storeCatalogue, {
        providers: [],
        clear: true,
      });

      return null;
    }
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`${url} answered ${response.status}`);
    }
    const providers = parseModelsDevRates(await readCatalogue(response));
    if (providers.length === 0) {
      throw new Error(`${url} returned no priced models`);
    }
    await ctx.runMutation(internal.modelPrices.store.storeCatalogue, {
      providers: providers,
      clear: false,
    });

    return null;
  },
});

/** The catalogue to fetch, or "" for none: models.dev on the managed cloud, only an explicit URL when self-hosted. */
function catalogueUrl(): string {
  const configured = process.env.BROODS_MODEL_PRICES_URL ?? "";
  if (configured !== "") return configured;

  return authProvider() === "self-host" ? "" : MODELS_DEV_API_URL;
}

/** The catalogue body, read in chunks and abandoned once past `MAX_CATALOGUE_BYTES`. */
async function readCatalogue(response: Response): Promise<ModelsDevApi> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("price catalogue has no body");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (let part = await reader.read(); !part.done; part = await reader.read()) {
    bytes += part.value.byteLength;
    if (bytes > MAX_CATALOGUE_BYTES) {
      await reader.cancel();
      throw new Error(`price catalogue is over ${MAX_CATALOGUE_BYTES} bytes`);
    }
    chunks.push(part.value);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
