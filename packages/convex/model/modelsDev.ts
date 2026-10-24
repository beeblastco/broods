/**
 * models.dev, the public catalogue `modelPrices/crawl.ts` reads token rates
 * from, and how its providers line up with the agent providers.
 */

import { normalizeModelId, type ModelTokenRates } from "./modelPricing";
import {
  ACCOUNT_MODEL_PROVIDER_NAMES,
  type AccountModelProviderName,
} from "./modelProviders";

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
          input?: number;
          output?: number;
          cache_read?: number;
          cache_write?: number;
        };
      }
    >;
  }
>;

/**
 * Each agent provider's rate rows, ids normalized. A model without an input
 * and output price is skipped; a missing cache rate falls back to the input
 * rate, since the provider gives no discount for it.
 */
export function parseModelsDevRates(body: ModelsDevApi): Array<{
  provider: string;
  models: Array<ModelTokenRates & { modelId: string }>;
}> {
  return ACCOUNT_MODEL_PROVIDER_NAMES.flatMap((provider) => {
    const source = MODELS_DEV_RENAMES[provider] ?? provider;
    const rows = new Map<string, ModelTokenRates & { modelId: string }>();
    for (const [id, model] of Object.entries(body[source]?.models ?? {})) {
      const cost = model.cost;
      const modelId = normalizeModelId(id);
      if (
        typeof cost?.input !== "number" ||
        typeof cost.output !== "number" ||
        rows.has(modelId)
      )
        continue;
      rows.set(modelId, {
        modelId: modelId,
        input: cost.input,
        output: cost.output,
        cacheRead:
          typeof cost.cache_read === "number" ? cost.cache_read : cost.input,
        cacheWrite:
          typeof cost.cache_write === "number" ? cost.cache_write : cost.input,
      });
    }

    return rows.size > 0
      ? [{ provider: provider, models: [...rows.values()] }]
      : [];
  });
}
