"use node";

// Node runtime: the models.dev catalogue is one ~6 MB JSON, too big for the default runtime.

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
const MAX_CATALOGUE_BYTES = 32 * 1024 * 1024;

// Neither source holds the other back: a bad BROODS_MODEL_PRICES throws only at the end.
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

// Self-hosted fetches only an explicit URL: most such deployments cannot reach the internet.
function catalogueUrl(): string {
  const configured = process.env.BROODS_MODEL_PRICES_URL ?? "";
  if (configured !== "") return configured;

  return authProvider() === "self-host" ? "" : MODELS_DEV_API_URL;
}

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
