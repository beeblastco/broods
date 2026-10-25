/**
 * Token cost on the dashboard: the Usage tab and the tracing task list read
 * model steps off the trace stream the same way and price them with the
 * crawled rates.
 */
import type { ObservabilitySpanRow } from "@/app/hooks/useObservabilityStream";
import type { ModelTokenUsage } from "@broods/convex/model/modelPricing";

/** A model as usage rows and rate lookups name it. */
export interface ModelRef {
  modelProvider: string;
  modelId: string;
}

/** One model's tokens, keyed the way usage rows name the model. */
export interface ModelUsage extends ModelRef, ModelTokenUsage {}

/** USD estimate with useful precision for small token batches. */
export function formatUsd(value: number): string {
  if (value > 0 && value < 0.0001) return "<$0.0001";

  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  });
}

/** `provider::model`, the key the model filter, its colors and the rate lookups share. */
export function modelKey(model: ModelRef): string {
  return `${model.modelProvider}::${model.modelId}`;
}

/** The model a run's root span names, or null before it names one. */
export function runModel(root: ObservabilitySpanRow): ModelRef | null {
  const { "model.provider": provider, "model.id": modelId } =
    root.attributes ?? {};

  return typeof provider === "string" && typeof modelId === "string"
    ? { modelProvider: provider, modelId: modelId }
    : null;
}

/** A model.step span's token counts, 0 for any it does not report. */
export function stepTokens(step: ObservabilitySpanRow): ModelTokenUsage {
  return {
    inputTokens: tokenAttribute(step, "model.input_tokens"),
    outputTokens: tokenAttribute(step, "model.output_tokens"),
    cachedInputTokens: tokenAttribute(step, "model.cached_input_tokens"),
    cacheWriteTokens: tokenAttribute(step, "model.cache_write_tokens"),
  };
}

function tokenAttribute(span: ObservabilitySpanRow, key: string): number {
  const value = span.attributes?.[key];

  return typeof value === "number" ? value : 0;
}
