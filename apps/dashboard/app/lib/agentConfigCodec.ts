/**
 * Dashboard-side agent config helpers.
 *
 * The flat <-> nested projection itself lives in `@broods/convex` and is
 * re-exported here: Convex mutations cannot import from the Next.js app tree, so
 * the shared direction has to be app -> convex. Only helpers with no server-side
 * caller stay in this file.
 */

export {
  fromNestedAgentConfig,
  substituteEnvPlaceholders,
  toNestedAgentConfig,
  type FlatAgentConfig,
  type FlatPatch,
  type NestedAgentConfig,
} from "@broods/convex/model/agentConfigCodec";

import { toNestedAgentConfig } from "@broods/convex/model/agentConfigCodec";
import type { FlatAgentConfig } from "@broods/convex/model/agentConfigCodec";
import { isPlainObject } from "./utils";

/**
 * Reads a single top-level branch (e.g. `workspace`, `skills`) from a flat agent
 * config as an object, returning `{}` when the config or branch is absent. Lets
 * node side-panels project just their slice without repeating the codec call.
 */
export function readAgentBranch<T extends Record<string, unknown>>(
  agentConfig: FlatAgentConfig | null | undefined,
  branch: string,
): T {
  if (!agentConfig) {
    return {} as T;
  }

  const nested = toNestedAgentConfig(agentConfig) as Record<string, unknown>;

  return (nested[branch] as T | undefined) ?? ({} as T);
}

/**
 * Vercel AI SDK `providerOptions` keys the budget/effort knobs own per provider.
 * Only these are cleared on rewrite so unrelated options the UI doesn't manage
 * (e.g. OpenAI `reasoningSummary`) survive. MiniMax's default provider is
 * Anthropic-compatible, so it reuses the `anthropic` slot. Mirrors the
 * per-provider table in the core docs (getting-started → "Reasoning / thinking
 * tokens").
 */
const REASONING_PROVIDER_KEYS: Record<string, string[]> = {
  openai: ["reasoningEffort"],
  anthropic: ["thinking", "effort"],
  google: ["thinkingConfig"],
};

/** The `providerOptions` slot a provider stores reasoning under, if any. */
function reasoningSlot(
  provider: string,
): "openai" | "anthropic" | "google" | undefined {
  if (provider === "minimax") return "anthropic";
  if (
    provider === "openai" ||
    provider === "anthropic" ||
    provider === "google"
  )
    return provider;

  return undefined;
}

/**
 * Build the reasoning slice for a provider's `providerOptions` sub-object from
 * the dashboard's two knobs. Budget tokens map to Anthropic/MiniMax `thinking`
 * or Google `thinkingConfig.thinkingBudget`; effort maps to OpenAI
 * `reasoningEffort` or Anthropic `effort`. Returns undefined when neither knob
 * applies to the slot.
 */
function reasoningSlice(
  slot: "openai" | "anthropic" | "google",
  next: { budgetTokens?: number; effort?: string },
): Record<string, unknown> | undefined {
  if (slot === "openai") {
    return next.effort ? { reasoningEffort: next.effort } : undefined;
  }
  if (slot === "google") {
    return typeof next.budgetTokens === "number"
      ? {
          thinkingConfig: {
            thinkingBudget: next.budgetTokens,
            includeThoughts: true,
          },
        }
      : undefined;
  }

  // anthropic (and minimax via the anthropic slot): prefer an explicit budget,
  // otherwise fall back to effort.
  if (typeof next.budgetTokens === "number") {
    return { thinking: { type: "enabled", budgetTokens: next.budgetTokens } };
  }

  return next.effort ? { effort: next.effort } : undefined;
}

/**
 * Rewrite the reasoning portion of a `model` branch for `provider`, returning a
 * new model object. Strips every provider's known reasoning keys first (so
 * toggling off or switching providers leaves no residue) plus the removed
 * top-level aliases (`thinking`, `thinkingEffort`, …) the core rejects, then
 * writes the active provider's reasoning under `model.providerOptions`.
 */
export function applyModelReasoning(
  model: Record<string, unknown>,
  provider: string,
  next: { budgetTokens?: number; effort?: string },
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...model };
  for (const alias of [
    "thinking",
    "thinkingConfig",
    "thinkingEffort",
    "reasoningEffort",
    "reasoningSummary",
    "effort",
  ]) {
    delete result[alias];
  }

  const providerOptions: Record<string, unknown> = isPlainObject(
    result.providerOptions,
  )
    ? { ...result.providerOptions }
    : {};
  for (const [slot, keys] of Object.entries(REASONING_PROVIDER_KEYS)) {
    if (!isPlainObject(providerOptions[slot])) continue;
    const sub = { ...providerOptions[slot] };
    for (const key of keys) delete sub[key];
    if (Object.keys(sub).length > 0) providerOptions[slot] = sub;
    else delete providerOptions[slot];
  }

  const slot = reasoningSlot(provider);
  const slice = slot ? reasoningSlice(slot, next) : undefined;
  if (slot && slice) {
    const existing = isPlainObject(providerOptions[slot])
      ? providerOptions[slot]
      : {};
    providerOptions[slot] = { ...existing, ...slice };
  }

  if (Object.keys(providerOptions).length > 0)
    result.providerOptions = providerOptions;
  else delete result.providerOptions;

  return result;
}

/**
 * Read the dashboard's reasoning knobs back out of a `model` branch's
 * `providerOptions`, regardless of which provider stored them. Inverse of
 * {@link applyModelReasoning}.
 */
export function readModelReasoning(modelBranch: Record<string, unknown>): {
  budgetTokens?: number;
  effort?: string;
} {
  const providerOptions = isPlainObject(modelBranch.providerOptions)
    ? modelBranch.providerOptions
    : {};
  const anthropic: Record<string, unknown> = isPlainObject(
    providerOptions.anthropic,
  )
    ? providerOptions.anthropic
    : {};
  const openai: Record<string, unknown> = isPlainObject(providerOptions.openai)
    ? providerOptions.openai
    : {};
  const google: Record<string, unknown> = isPlainObject(providerOptions.google)
    ? providerOptions.google
    : {};
  const anthropicThinking: Record<string, unknown> = isPlainObject(
    anthropic.thinking,
  )
    ? anthropic.thinking
    : {};
  const googleThinking: Record<string, unknown> = isPlainObject(
    google.thinkingConfig,
  )
    ? google.thinkingConfig
    : {};

  const budgetTokens =
    typeof anthropicThinking.budgetTokens === "number"
      ? anthropicThinking.budgetTokens
      : typeof googleThinking.thinkingBudget === "number"
        ? googleThinking.thinkingBudget
        : undefined;
  const effort =
    typeof openai.reasoningEffort === "string"
      ? openai.reasoningEffort
      : typeof anthropic.effort === "string"
        ? anthropic.effort
        : undefined;

  return {
    ...(budgetTokens !== undefined ? { budgetTokens: budgetTokens } : {}),
    ...(effort ? { effort: effort } : {}),
  };
}
