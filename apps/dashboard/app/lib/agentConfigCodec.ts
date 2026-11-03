export {
  fromNestedAgentConfig,
  toNestedAgentConfig,
  type FlatAgentConfig,
} from "@broods/convex/model/agentConfigCodec";

import { toNestedAgentConfig } from "@broods/convex/model/agentConfigCodec";
import type { FlatAgentConfig } from "@broods/convex/model/agentConfigCodec";
import { configObject, parseOr } from "@broods/convex/model/storedJson";

// Only these are cleared on rewrite, so options the UI doesn't manage survive.
const REASONING_PROVIDER_KEYS: Record<string, string[]> = {
  openai: ["reasoningEffort"],
  anthropic: ["thinking", "effort"],
  google: ["thinkingConfig"],
};

export function applyModelReasoning(
  model: Record<string, unknown>,
  provider: string,
  next: { budgetTokens?: number; effort?: string },
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...model };
  const providerOptions: Record<string, unknown> = {
    ...parseOr(configObject, result.providerOptions),
  };
  for (const [slot, keys] of Object.entries(REASONING_PROVIDER_KEYS)) {
    const sub = parseOr(configObject, providerOptions[slot]);
    if (!sub) continue;
    for (const key of keys) delete sub[key];
    if (Object.keys(sub).length > 0) providerOptions[slot] = sub;
    else delete providerOptions[slot];
  }

  const slot = reasoningSlot(provider);
  const slice = slot ? reasoningSlice(slot, next) : undefined;
  if (slot && slice) {
    providerOptions[slot] = {
      ...parseOr(configObject, providerOptions[slot]),
      ...slice,
    };
  }

  if (Object.keys(providerOptions).length > 0)
    result.providerOptions = providerOptions;
  else delete result.providerOptions;

  return result;
}

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

export function readModelReasoning(modelBranch: Record<string, unknown>): {
  budgetTokens?: number;
  effort?: string;
} {
  const providerOptions = parseOr(
    configObject,
    modelBranch.providerOptions,
    {},
  );
  const anthropic = parseOr(configObject, providerOptions.anthropic, {});
  const openai = parseOr(configObject, providerOptions.openai, {});
  const google = parseOr(configObject, providerOptions.google, {});
  const anthropicThinking = parseOr(configObject, anthropic.thinking, {});
  const googleThinking = parseOr(configObject, google.thinkingConfig, {});

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

  if (typeof next.budgetTokens === "number") {
    return { thinking: { type: "enabled", budgetTokens: next.budgetTokens } };
  }

  return next.effort ? { effort: next.effort } : undefined;
}

function reasoningSlot(
  provider: string,
): "openai" | "anthropic" | "google" | undefined {
  if (provider === "minimax") return "anthropic";
  if (provider === "chatgpt") return "openai";
  if (
    provider === "openai" ||
    provider === "anthropic" ||
    provider === "google"
  )
    return provider;

  return undefined;
}
