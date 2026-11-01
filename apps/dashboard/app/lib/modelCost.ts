import type { ObservabilitySpanRow } from "@/app/hooks/useObservabilityStream";
import type { ModelTokenUsage } from "@broods/convex/model/modelPricing";

export interface ModelRef {
  modelProvider: string;
  modelId: string;
}

export interface ModelUsage extends ModelRef, ModelTokenUsage {}

export function formatUsd(value: number): string {
  if (value > 0 && value < 0.0001) return "<$0.0001";

  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  });
}

export function modelKey(model: ModelRef): string {
  return `${model.modelProvider}::${model.modelId}`;
}

export function numberAttribute(
  span: ObservabilitySpanRow,
  key: string,
): number {
  const value = span.attributes?.[key];

  return typeof value === "number" ? value : 0;
}

// A phase that reports tokens, like a compaction, called the model too.
export function isModelCallSpan(span: ObservabilitySpanRow): boolean {
  return (
    span.kind === "model.step" ||
    (span.kind === "phase" &&
      typeof span.attributes?.["model.total_tokens"] === "number")
  );
}

export function runModel(root: ObservabilitySpanRow): ModelRef | null {
  const { "model.provider": provider, "model.id": modelId } =
    root.attributes ?? {};

  return typeof provider === "string" && typeof modelId === "string"
    ? { modelProvider: provider, modelId: modelId }
    : null;
}

export function stepTokens(step: ObservabilitySpanRow): ModelTokenUsage {
  return {
    inputTokens: numberAttribute(step, "model.input_tokens"),
    outputTokens: numberAttribute(step, "model.output_tokens"),
    cachedInputTokens: numberAttribute(step, "model.cached_input_tokens"),
    cacheWriteTokens: numberAttribute(step, "model.cache_write_tokens"),
  };
}
