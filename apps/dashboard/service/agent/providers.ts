/**
 * Provider-specific option resolution for thinking, context management, and betas.
 */
import type { ProviderOptions } from "@ai-sdk/provider-utils";


/** Shared Anthropic beta feature flags applied to all Anthropic-routed requests. */
const ANTHROPIC_BETAS = [
  "tool-search-tool-2025-10-19",
  "context-management-2025-06-27",
  "fine-grained-tool-streaming-2025-05-14",
  "tool-examples-2025-10-29",
];

/** Shared context management edits for clearing stale thinking and tool-use blocks. */
const CONTEXT_MANAGEMENT_EDITS = [
  {
    type: "clear_thinking_20251015",
    keep: { type: "thinking_turns", value: 2 },
  },
  {
    type: "clear_tool_uses_20250919",
    trigger: { type: "input_tokens", value: 180000 },
    keep: { type: "tool_uses", value: 3 },
    clear_at_least: { type: "input_tokens", value: 5000 },
    exclude_tools: ["web_search", "memory"],
  },
];

/** Returns true if value is a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merges stored providerOptions with provider-specific defaults for thinking, context management, and betas.
 * @param modelId The model identifier string
 * @param customProviderOptions Custom provider options from the agent config
 * @returns Resolved provider options ready for streamText()
 */
export function getProviderOptionsForModel(
  modelId: string | undefined,
  customProviderOptions?: Record<string, unknown>,
): ProviderOptions {
  const isAnthropicModel = modelId?.toLowerCase().includes("anthropic") || modelId?.toLowerCase().includes("claude");

  if (customProviderOptions) {
    const anthropicOpts = isRecord(customProviderOptions.anthropic) ? customProviderOptions.anthropic : undefined;
    const bedrockOpts = isRecord(customProviderOptions.bedrock) ? customProviderOptions.bedrock : undefined;

    const anthropicThinking = anthropicOpts && isRecord(anthropicOpts.thinking) ? anthropicOpts.thinking : undefined;
    const bedrockReasoning = bedrockOpts && isRecord(bedrockOpts.reasoningConfig) ? bedrockOpts.reasoningConfig : undefined;

    return {
      ...customProviderOptions,
      // Anthropic direct API options (thinking, context management, betas)
      ...(anthropicOpts && {
        anthropic: {
          ...anthropicOpts,
          betas: ANTHROPIC_BETAS,
          thinking: anthropicThinking?.type === "enabled"
            ? {
              type: "enabled",
              budget_tokens: typeof anthropicThinking.budget_tokens === "number" ? anthropicThinking.budget_tokens : 4096,
            }
            : { type: "disabled" },
          contextManagement: { edits: CONTEXT_MANAGEMENT_EDITS },
        },
      }),
      // AWS Bedrock options (reasoning config differs for Anthropic vs non-Anthropic models)
      ...(bedrockOpts && {
        bedrock: {
          ...bedrockOpts,
          anthropicBeta: ANTHROPIC_BETAS,
          reasoningConfig: bedrockReasoning?.type === "enabled"
            ? {
              type: "enabled",
              ...(isAnthropicModel
                ? { budgetTokens: typeof bedrockReasoning.budgetTokens === "number" ? bedrockReasoning.budgetTokens : 4096 }
                : { maxReasoningEffort: typeof bedrockReasoning.maxReasoningEffort === "string" ? bedrockReasoning.maxReasoningEffort : "low" }
              ),
            }
            : { type: "disabled" },
          cachePoint: true,
          extra_body: { contextManagement: { edits: CONTEXT_MANAGEMENT_EDITS } },
        },
      }),
    };
  }

  // Default: disable reasoning for Anthropic models, enable low effort for others
  return {
    bedrock: {
      reasoningConfig: isAnthropicModel
        ? { type: "disabled" }
        : { type: "enabled", maxReasoningEffort: "low" },
      cachePoint: true,
    },
  };
}
