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

/** One agent provider's rate rows, as the `modelPrices` table stores them. */
export interface ProviderRates {
  provider: string;
  models: Array<ModelTokenRates & { modelId: string }>;
}

/**
 * `BROODS_MODEL_PRICES`: agent provider, then model id, then USD per million
 * tokens. Cache rates are optional and default to the input rate.
 */
type InlinePrices = Record<
  string,
  Record<
    string,
    {
      input?: unknown;
      output?: unknown;
      cacheRead?: unknown;
      cacheWrite?: unknown;
    }
  >
>;

/**
 * The org's own rates from `BROODS_MODEL_PRICES`, empty when unset.
 * @throws a `BROODS_MODEL_PRICES` error when the JSON is malformed or
 * mis-shaped, names an unknown provider, or a model lacks a valid input or
 * output rate, so a config mistake fails the crawl loudly instead of pricing
 * nothing
 */
export function parseInlinePrices(raw: string): ProviderRates[] {
  if (raw.trim() === "") return [];
  try {
    const body: InlinePrices = JSON.parse(raw);

    return Object.entries(body).map(([provider, models]) => {
      if (!isAccountModelProviderName(provider)) {
        throw new Error(`unknown provider ${provider}`);
      }
      if (Object.keys(models).length === 0) {
        throw new Error(`${provider} lists no models`);
      }

      return {
        provider: provider,
        models: Object.entries(models).map(([id, cost]) => {
          const unknown = Object.keys(cost).filter(
            (key) => !INLINE_RATE_KEYS.has(key),
          );
          if (unknown.length > 0) {
            throw new Error(
              `${provider}/${id} has unknown keys ${unknown.join(", ")}; use input, output, cacheRead, cacheWrite`,
            );
          }
          if (!isRate(cost.input) || !isRate(cost.output)) {
            throw new Error(
              `${provider}/${id} needs non-negative input and output rates`,
            );
          }

          return {
            modelId: normalizeModelId(id),
            input: cost.input,
            output: cost.output,
            cacheRead: isRate(cost.cacheRead) ? cost.cacheRead : cost.input,
            cacheWrite: isRate(cost.cacheWrite) ? cost.cacheWrite : cost.input,
          };
        }),
      };
    });
  } catch (error) {
    throw new Error(
      `BROODS_MODEL_PRICES: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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

/** A finite, non-negative USD rate. */
function isRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
