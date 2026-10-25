/**
 * Where `modelPrices/crawl.ts` reads token rates from: the models.dev
 * catalogue (or a copy at `BROODS_MODEL_PRICES_URL`), and the org's own rates
 * in `BROODS_MODEL_PRICES`. Both come out as rows per agent provider.
 */

import { normalizeModelId, type ModelTokenRates } from "./modelPricing";
import {
  ACCOUNT_MODEL_PROVIDER_NAMES,
  isAccountModelProviderName,
  type AccountModelProviderName,
} from "./modelProviders";
import { isPlainObject } from "./objects";

/** The rate keys `BROODS_MODEL_PRICES` takes per model. */
const INLINE_RATE_KEYS: ReadonlySet<string> = new Set([
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
]);

/** Where models.dev publishes every provider's models and rates. */
export const MODELS_DEV_API_URL = "https://models.dev/api.json";

/**
 * Agent providers whose models.dev provider has another name. Every other
 * provider reads the same name; `custom`, `ollama` and `v0` find none there
 * and stay unpriced.
 */
const MODELS_DEV_RENAMES: Partial<Record<AccountModelProviderName, string>> = {
  bedrock: "amazon-bedrock",
  chatgpt: "openai",
  cloudflare: "cloudflare-workers-ai",
  fireworks: "fireworks-ai",
  vertex: "google-vertex",
};

/** The slice of models.dev's `api.json` the crawl reads. */
export type ModelsDevApi = Record<
  string,
  {
    models?: Record<
      string,
      {
        cost?: {
          input?: unknown;
          output?: unknown;
          cache_read?: unknown;
          cache_write?: unknown;
        };
      }
    >;
  }
>;

/** One agent provider's org-set rates; a cache rate left out is the catalogue's. */
export interface OverrideRates {
  provider: string;
  models: Array<
    Pick<ModelTokenRates, "input" | "output"> &
      Partial<Pick<ModelTokenRates, "cacheRead" | "cacheWrite">> & {
        modelId: string;
      }
  >;
}

/** One agent provider's catalogue rates, as the `modelPrices` table stores them. */
export interface ProviderRates {
  provider: string;
  models: Array<ModelTokenRates & { modelId: string }>;
}

/**
 * The org's own rates from `BROODS_MODEL_PRICES`: agent provider, then model
 * id, then USD per million tokens for `input`, `output` and optionally
 * `cacheRead` and `cacheWrite`. Empty when unset. The value is text an
 * operator types, so its shape is checked at runtime.
 * @throws a `BROODS_MODEL_PRICES` error naming the mistake, so a bad value
 * fails the crawl loudly instead of pricing wrong
 */
export function parseInlinePrices(raw: string): OverrideRates[] {
  if (raw.trim() === "") return [];
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch (error) {
    throw inlineError(error instanceof Error ? error.message : String(error));
  }
  if (!isPlainObject(body)) {
    throw inlineError("must be an object keyed by agent provider");
  }

  return Object.entries(body).map(([provider, models]) => {
    if (!isAccountModelProviderName(provider)) {
      throw inlineError(`unknown provider ${provider}`);
    }
    if (!isPlainObject(models) || Object.keys(models).length === 0) {
      throw inlineError(`${provider} must map model ids to rates`);
    }

    return {
      provider: provider,
      models: Object.entries(models).map(([id, rates]) => {
        if (!isPlainObject(rates)) {
          throw inlineError(`${provider}/${id} must be an object of rates`);
        }
        const unknown = Object.keys(rates).filter(
          (key) => !INLINE_RATE_KEYS.has(key),
        );
        if (unknown.length > 0) {
          throw inlineError(
            `${provider}/${id} has unknown keys ${unknown.join(", ")}; use input, output, cacheRead, cacheWrite`,
          );
        }
        const { input, output, cacheRead, cacheWrite } = rates;
        if (
          !isRate(input) ||
          !isRate(output) ||
          (cacheRead !== undefined && !isRate(cacheRead)) ||
          (cacheWrite !== undefined && !isRate(cacheWrite))
        ) {
          throw inlineError(
            `${provider}/${id} needs non-negative numeric rates`,
          );
        }

        return {
          modelId: normalizeModelId(id),
          input: input,
          output: output,
          ...(cacheRead !== undefined ? { cacheRead: cacheRead } : {}),
          ...(cacheWrite !== undefined ? { cacheWrite: cacheWrite } : {}),
        };
      }),
    };
  });
}

/**
 * Each agent provider's rate rows, ids normalized. A model without a valid
 * input and output price is skipped; a missing cache rate falls back to the
 * input rate, since the provider gives no discount for it.
 */
export function parseModelsDevRates(body: ModelsDevApi): ProviderRates[] {
  return ACCOUNT_MODEL_PROVIDER_NAMES.flatMap((provider) => {
    const source = MODELS_DEV_RENAMES[provider] ?? provider;
    const rows = new Map<string, ModelTokenRates & { modelId: string }>();
    for (const [id, model] of Object.entries(body[source]?.models ?? {})) {
      const cost = model.cost;
      const modelId = normalizeModelId(id);
      if (!isRate(cost?.input) || !isRate(cost.output) || rows.has(modelId))
        continue;
      rows.set(modelId, {
        modelId: modelId,
        input: cost.input,
        output: cost.output,
        cacheRead: isRate(cost.cache_read) ? cost.cache_read : cost.input,
        cacheWrite: isRate(cost.cache_write) ? cost.cache_write : cost.input,
      });
    }

    return rows.size > 0
      ? [{ provider: provider, models: [...rows.values()] }]
      : [];
  });
}

function inlineError(problem: string): Error {
  return new Error(`BROODS_MODEL_PRICES: ${problem}`);
}

/** A finite, non-negative USD rate. */
function isRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
