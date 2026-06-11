/**
 * Agent-configured provider resolution for harness-processing.
 * Keep provider construction and AI SDK setting projection here.
 */

import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createGateway } from "@ai-sdk/gateway";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createMinimax } from "vercel-minimax-ai-provider";
import { jsonSchema, Output, type LanguageModel } from "ai";
import type {
  AgentConfig,
  AccountModelProviderName,
  AgentModelOutputConfig,
  AgentProviderSettings,
} from "../_shared/storage/index.ts";

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
      return resolveProviderModel(providerName, createGoogleGenerativeAI(providerConfig as never), modelId);
    case "openai":
      return resolveProviderModel(providerName, createOpenAI(providerConfig as never), modelId);
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
    options: _options,
    output: _output,
    ...settings
  } = agentConfig.model ?? {};

  return settings;
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
  return providerConfig;
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
