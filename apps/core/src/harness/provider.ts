/**
 * Agent-configured provider resolution for harness-processing.
 * Keep provider construction and AI SDK setting projection here.
 */

import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createBaseten } from "@ai-sdk/baseten";
import { createCerebras } from "@ai-sdk/cerebras";
import { createCohere } from "@ai-sdk/cohere";
import { createDeepInfra } from "@ai-sdk/deepinfra";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createFireworks } from "@ai-sdk/fireworks";
import { createGateway } from "@ai-sdk/gateway";
import { createGoogle } from "@ai-sdk/google";
import { createGoogleVertex } from "@ai-sdk/google-vertex";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createPerplexity } from "@ai-sdk/perplexity";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { createTogetherAI } from "@ai-sdk/togetherai";
import { createVercel } from "@ai-sdk/vercel";
import { createXai } from "@ai-sdk/xai";
import {
  jsonSchema,
  Output,
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware,
} from "ai";
import { createMinimax } from "vercel-minimax-ai-provider";
import type { AccountModelProviderName } from "../shared/providers.ts";
import type {
  AgentConfig,
  AgentModelOutputConfig,
  AgentModelProviderOptions,
  AgentProviderSettings,
} from "../shared/domain/agent-config.ts";

/**
 * What every AI SDK provider factory has in common: settings in, a callable
 * provider out. Both halves stay the SDK's own — the settings each provider
 * accepts are read off its factory, never restated here.
 */
type ModelProviderFactory = (settings: never) => ModelProviderInstance;

interface ModelProviderInstance {
  (modelId: string): LanguageModel;
}

/**
 * Name → Vercel AI SDK factory. Adding a provider is one import and one line;
 * `satisfies` makes a name the shared list carries without a factory (or a
 * factory the AI SDK cannot back) a compile error. Built per call so each
 * factory is read off its live module binding, which is what lets a test swap a
 * provider module out from under an already-loaded harness.
 */
export function modelProviderFactories() {
  return {
    anthropic: createAnthropic,
    azure: createAzure,
    baseten: createBaseten,
    bedrock: createAmazonBedrock,
    cerebras: createCerebras,
    cohere: createCohere,
    custom: createOpenAICompatible,
    deepinfra: createDeepInfra,
    deepseek: createDeepSeek,
    fireworks: createFireworks,
    google: createGoogle,
    groq: createGroq,
    minimax: createMinimax,
    mistral: createMistral,
    openai: createOpenAI,
    perplexity: createPerplexity,
    togetherai: createTogetherAI,
    v0: createVercel,
    vercel: createGateway,
    vertex: createGoogleVertex,
    xai: createXai,
  } satisfies Record<AccountModelProviderName, ModelProviderFactory>;
}

/** The constructor settings one provider accepts, straight from the AI SDK. */
export type ProviderSettingsFor<K extends AccountModelProviderName> =
  Parameters<ReturnType<typeof modelProviderFactories>[K]>[0];

export interface ResolvedModelProvider {
  providerName: AccountModelProviderName;
  provider: unknown;
  model: LanguageModel;
}

export type ModelOutputSpec =
  | ReturnType<typeof Output.object>
  | ReturnType<typeof Output.array>
  | ReturnType<typeof Output.choice>
  | ReturnType<typeof Output.json>;

export function resolveConfiguredModel(
  agentConfig: AgentConfig,
): ResolvedModelProvider {
  const providerName = requireModelProvider(agentConfig);
  const modelId = requireModelId(agentConfig);
  const providerConfig = requireProviderSettings(agentConfig, providerName);
  if (providerName === "custom") {
    return resolveOpenAICompatibleModel(providerName, providerConfig, modelId);
  }

  // The registry's value type is a union of factories, so its parameter narrows
  // to an intersection no single provider's settings satisfy. Settings are
  // validated by `normalizeProviderSettings` and passed through verbatim, so the
  // cast is the one seam where account config meets the SDK's own typing.
  const createProvider = modelProviderFactories()[providerName] as (
    settings: AgentProviderSettings,
  ) => ModelProviderInstance;
  const provider = createProvider(providerConfig);

  return {
    providerName: providerName,
    provider: provider,
    model: provider(modelId),
  };
}

export function modelSettingsFromModelConfig(
  agentConfig: AgentConfig,
): Record<string, unknown> {
  const {
    provider: _provider,
    modelId: _modelId,
    providerOptions: _providerOptions,
    output: _output,
    ...settings
  } = agentConfig.model ?? {};

  return settings;
}

export function providerOptionsFromModelConfig(
  agentConfig: AgentConfig,
): AgentModelProviderOptions | undefined {
  return agentConfig.model?.providerOptions;
}

export function modelOutputFromModelConfig(
  agentConfig: AgentConfig,
): ModelOutputSpec | undefined {
  const output = agentConfig.model?.output;
  if (!output || output.type === "text") {
    return undefined;
  }

  return createModelOutput(output);
}

// vLLM-style chat templates often accept only a single system message, and
// OVH's Qwen endpoints fail SOFT on extras: HTTP 200 with an immediately-empty
// stream (`data: [DONE]`), which surfaces as "Model returned empty response".
// The harness legitimately sends two (the base prompt + the dynamic context
// snapshot), so fold every system message into one before the request leaves.
export const mergeSystemMessagesMiddleware: LanguageModelMiddleware = {
  transformParams: async ({ params }) => {
    const systems = params.prompt.filter(
      (message) => message.role === "system",
    );
    if (systems.length <= 1) return params;

    return {
      ...params,
      prompt: [
        {
          role: "system",
          content: systems.map((message) => message.content).join("\n\n"),
        },
        ...params.prompt.filter((message) => message.role !== "system"),
      ],
    };
  },
};

// The same endpoints have two streaming quirks the custom-provider path must
// absorb. First, `reasoning`/`reasoning_content` chunks may carry a growing
// snapshot of the whole reasoning text instead of an increment, which every
// downstream consumer (Slack Thinking card, chat SDK streams, persisted
// messages) doubles by appending. Second, usage omits
// `completion_tokens_details.reasoning_tokens`, so reasoning tokens read as 0
// even when most of the output was thinking. Rewrite snapshot deltas to their
// new suffix, and when the endpoint reports no reasoning-token split, estimate
// it from the reasoning/text character share of the reported output total.
export const normalizeStreamDeltasMiddleware: LanguageModelMiddleware = {
  wrapStream: async ({ doStream }) => {
    const { stream, ...rest } = await doStream();
    const accumulated = new Map<string, string>();
    const chars = { "reasoning-delta": 0, "text-delta": 0 };

    return {
      ...rest,
      stream: stream.pipeThrough(
        new TransformStream<
          LanguageModelV4StreamPart,
          LanguageModelV4StreamPart
        >({
          transform: function (part, controller) {
            if (part.type === "reasoning-delta" || part.type === "text-delta") {
              const key = `${part.type}:${part.id}`;
              const previous = accumulated.get(key) ?? "";
              const delta =
                previous && part.delta.startsWith(previous)
                  ? part.delta.slice(previous.length)
                  : part.delta;
              accumulated.set(key, previous + delta);
              chars[part.type] += delta.length;
              if (delta) {
                controller.enqueue(
                  delta === part.delta ? part : { ...part, delta: delta },
                );
              }

              return;
            }

            if (part.type === "finish" && chars["reasoning-delta"] > 0) {
              const output = part.usage.outputTokens;
              if (output.total && !output.reasoning) {
                const reasoning = Math.round(
                  (output.total * chars["reasoning-delta"]) /
                    (chars["reasoning-delta"] + chars["text-delta"]),
                );
                controller.enqueue({
                  ...part,
                  usage: {
                    ...part.usage,
                    outputTokens: {
                      total: output.total,
                      text: output.total - reasoning,
                      reasoning: reasoning,
                    },
                  },
                });

                return;
              }
            }

            controller.enqueue(part);
          },
        }),
      ),
    };
  },
};

function resolveOpenAICompatibleModel(
  providerName: "custom",
  providerConfig: AgentProviderSettings,
  modelId: string,
): ResolvedModelProvider {
  const { base_url: _baseUrl, ...openAIConfig } = providerConfig;
  // @ai-sdk/openai-compatible instead of @ai-sdk/openai: vLLM-style endpoints
  // return thinking text in `reasoning`/`reasoning_content` fields, which only
  // the compatible provider parses into reasoning parts (#115).
  const provider = createOpenAICompatible({
    ...openAIConfig,
    baseURL: customProviderBaseURL(providerConfig) ?? "",
    name:
      typeof providerConfig.name === "string"
        ? providerConfig.name
        : providerName,
    includeUsage: true,
  });

  return {
    providerName: providerName,
    provider: provider,
    model: wrapLanguageModel({
      model: provider(modelId),
      middleware: [
        mergeSystemMessagesMiddleware,
        normalizeStreamDeltasMiddleware,
      ],
    }),
  };
}

function requireModelProvider(
  agentConfig: AgentConfig,
): AccountModelProviderName {
  const provider = agentConfig.model?.provider;
  if (!provider) {
    throw new Error("config.model.provider is required");
  }

  return provider;
}

function requireModelId(agentConfig: AgentConfig): string {
  const modelId = agentConfig.model?.modelId;
  if (!modelId) {
    throw new Error("config.model.modelId is required");
  }

  return modelId;
}

function requireProviderSettings(
  agentConfig: AgentConfig,
  providerName: AccountModelProviderName,
): AgentProviderSettings {
  const providerConfig = agentConfig.provider?.[providerName];
  if (!providerConfig) {
    throw new Error(`config.provider.${providerName} is required`);
  }
  if (!providerConfig.apiKey) {
    throw new Error(`config.provider.${providerName}.apiKey is required`);
  }
  if (providerName === "custom" && !customProviderBaseURL(providerConfig)) {
    const hint =
      (providerConfig as Record<string, unknown>).baseUrl !== undefined
        ? ` (found "baseUrl" — use "base_url" or "baseURL")`
        : "";
    throw new Error(`config.provider.custom.base_url is required${hint}`);
  }

  return providerConfig;
}

function customProviderBaseURL(
  providerConfig: AgentProviderSettings,
): string | undefined {
  const raw =
    typeof providerConfig.base_url === "string"
      ? providerConfig.base_url
      : providerConfig.baseURL;
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();

  return trimmed || undefined;
}

// Parse the structure output to vercel-ai sdk type
function createModelOutput(
  output: Exclude<AgentModelOutputConfig, { type: "text" }>,
): ModelOutputSpec {
  switch (output.type) {
    case "object":
      return Output.object({
        schema: jsonSchema(output.schema as never),
        ...(output.name ? { name: output.name } : {}),
        ...(output.description ? { description: output.description } : {}),
      });
    case "array":
      return Output.array({
        element: jsonSchema(output.element as never),
        ...(output.name ? { name: output.name } : {}),
        ...(output.description ? { description: output.description } : {}),
      });
    case "choice":
      return Output.choice({
        options: output.options,
        ...(output.name ? { name: output.name } : {}),
        ...(output.description ? { description: output.description } : {}),
      });
    case "json":
      return Output.json({
        ...(output.name ? { name: output.name } : {}),
        ...(output.description ? { description: output.description } : {}),
      });
  }
}
