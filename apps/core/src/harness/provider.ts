/**
 * Agent-configured provider resolution for harness-processing.
 * Keep provider construction and AI SDK setting projection here.
 */

import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGateway } from "@ai-sdk/gateway";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createMinimax } from "vercel-minimax-ai-provider";
import { jsonSchema, Output, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";
import type {
  AgentConfig,
  AccountModelProviderName,
  AgentModelOutputConfig,
  AgentModelProviderOptions,
  AgentProviderSettings,
} from "../shared/storage/index.ts";

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

export function resolveConfiguredModel(agentConfig: AgentConfig): ResolvedModelProvider {
  const providerName = requireModelProvider(agentConfig);
  const modelId = requireModelId(agentConfig);
  const providerConfig = requireProviderSettings(agentConfig, providerName);

  switch (providerName) {
    case "google":
      return resolveProviderModel(providerName, createGoogle(providerConfig as never), modelId);
    case "openai":
      return resolveProviderModel(providerName, createOpenAI(providerConfig as never), modelId);
    case "custom":
      return resolveOpenAICompatibleModel(providerName, providerConfig, modelId);
    case "anthropic":
      return resolveProviderModel(providerName, createAnthropic(providerConfig as never), modelId);
    case "bedrock":
      return resolveProviderModel(providerName, createAmazonBedrock(providerConfig as never), modelId);
    case "gateway":
      return resolveProviderModel(providerName, createGateway(providerConfig as never), modelId);
    case "minimax":
      return resolveProviderModel(providerName, createMinimax(providerConfig as never), modelId);
    default:
      throw new Error(`Unsupported model provider: ${String(providerName)}`);
  }
}

export function modelSettingsFromModelConfig(agentConfig: AgentConfig): Record<string, unknown> {
  const {
    provider: _provider,
    modelId: _modelId,
    providerOptions: _providerOptions,
    output: _output,
    ...settings
  } = agentConfig.model ?? {};

  return settings;
}

export function providerOptionsFromModelConfig(agentConfig: AgentConfig): AgentModelProviderOptions | undefined {
  return agentConfig.model?.providerOptions;
}

export function modelOutputFromModelConfig(agentConfig: AgentConfig): ModelOutputSpec | undefined {
  const output = agentConfig.model?.output;
  if (!output || output.type === "text") {
    return undefined;
  }

  return createModelOutput(output);
}

function resolveProviderModel(
  providerName: AccountModelProviderName,
  provider: (modelId: string) => LanguageModel,
  modelId: string,
): ResolvedModelProvider {
  return {
    providerName,
    provider,
    model: provider(modelId),
  };
}

// vLLM-style chat templates often accept only a single system message, and
// OVH's Qwen endpoints fail SOFT on extras: HTTP 200 with an immediately-empty
// stream (`data: [DONE]`), which surfaces as "Model returned empty response".
// The harness legitimately sends two (the base prompt + the dynamic context
// snapshot), so fold every system message into one before the request leaves.
export const mergeSystemMessagesMiddleware: LanguageModelMiddleware = {
  transformParams: async ({ params }) => {
    const systems = params.prompt.filter((message) => message.role === "system");
    if (systems.length <= 1) return params;
    return {
      ...params,
      prompt: [
        { role: "system", content: systems.map((message) => message.content).join("\n\n") },
        ...params.prompt.filter((message) => message.role !== "system"),
      ],
    };
  },
};

function resolveOpenAICompatibleModel(
  providerName: AccountModelProviderName,
  providerConfig: AgentProviderSettings,
  modelId: string,
): ResolvedModelProvider {
  const { base_url: _baseUrl, ...openAIConfig } = providerConfig;
  // @ai-sdk/openai-compatible instead of @ai-sdk/openai: vLLM-style endpoints
  // return thinking text in `reasoning`/`reasoning_content` fields, which only
  // the compatible provider parses into reasoning parts (#115).
  const provider = createOpenAICompatible({
    ...(openAIConfig as Record<string, unknown>),
    baseURL: customProviderBaseURL(providerConfig) ?? "",
    name: typeof providerConfig.name === "string" ? providerConfig.name : providerName,
    includeUsage: true,
  });

  return {
    providerName,
    provider,
    model: wrapLanguageModel({ model: provider(modelId), middleware: mergeSystemMessagesMiddleware }),
  };
}

function requireModelProvider(agentConfig: AgentConfig): AccountModelProviderName {
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
    const hint = (providerConfig as Record<string, unknown>).baseUrl !== undefined
      ? ` (found "baseUrl" — use "base_url" or "baseURL")`
      : "";
    throw new Error(`config.provider.custom.base_url is required${hint}`);
  }
  return providerConfig;
}

function customProviderBaseURL(providerConfig: AgentProviderSettings): string | undefined {
  const raw = typeof providerConfig.base_url === "string" ? providerConfig.base_url : providerConfig.baseURL;
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();

  return trimmed || undefined;
}

// Parse the structure output to vercel-ai sdk type
function createModelOutput(output: Exclude<AgentModelOutputConfig, { type: "text" }>): ModelOutputSpec {
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
