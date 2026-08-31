/**
 * Shared model-provider resolution for AI SDK Harness adapters.
 */

import type { HarnessV1AuthenticationEnvironment } from "@ai-sdk/harness";
import type {
  AgentConfig,
  AgentProviderSettings,
} from "../../shared/domain/agent-config.ts";

type HarnessProviderName = NonNullable<
  NonNullable<AgentConfig["model"]>["provider"]
>;

export function requireHarnessModelId(agentConfig: AgentConfig): string {
  const modelId = agentConfig.model?.modelId;
  if (!modelId) {
    throw new Error("config.model.modelId is required for config.harness");
  }

  return modelId;
}

export function requireHarnessProviderName(
  agentConfig: AgentConfig,
): HarnessProviderName {
  const providerName = agentConfig.model?.provider;
  if (!providerName) {
    throw new Error("config.model.provider is required for config.harness");
  }

  return providerName;
}

export function requireHarnessProviderSettings(
  agentConfig: AgentConfig,
  providerName: HarnessProviderName,
): AgentProviderSettings {
  const settings = agentConfig.provider?.[providerName];
  if (!settings) {
    throw new Error(
      `config.provider.${providerName} is required for config.harness`,
    );
  }
  if (!settings.apiKey) {
    throw new Error(
      `config.provider.${providerName}.apiKey is required for config.harness`,
    );
  }

  return settings;
}

/**
 * Anthropic credentials for the `auth` option. Since `@ai-sdk/harness` 1.0.92
 * that option is either a mode string or an isolated environment that replaces
 * the host process env for credential discovery; every adapter here supplies
 * the environment so nothing leaks in from the core container.
 */
export function resolveAnthropicAuthEnv(
  provider: AgentProviderSettings,
): HarnessV1AuthenticationEnvironment {
  const baseUrl = resolveHarnessProviderBaseUrl(provider);

  return {
    ANTHROPIC_API_KEY: provider.apiKey!,
    ...(baseUrl ? { ANTHROPIC_BASE_URL: baseUrl } : {}),
  };
}

export function resolveAnthropicOrVercelAuthEnv(
  providerName: "anthropic" | "vercel",
  provider: AgentProviderSettings,
): HarnessV1AuthenticationEnvironment {
  return providerName === "anthropic"
    ? resolveAnthropicAuthEnv(provider)
    : resolveGatewayAuthEnv(provider);
}

/**
 * Vercel AI Gateway credentials. Adapters pick the gateway route whenever
 * `AI_GATEWAY_API_KEY` is present in the supplied environment, so this record
 * needs no accompanying mode string.
 */
export function resolveGatewayAuthEnv(
  provider: AgentProviderSettings,
): HarnessV1AuthenticationEnvironment {
  const baseUrl = resolveHarnessProviderBaseUrl(provider);

  return {
    AI_GATEWAY_API_KEY: provider.apiKey!,
    ...(baseUrl ? { AI_GATEWAY_BASE_URL: baseUrl } : {}),
  };
}

export function resolveHarnessProviderBaseUrl(
  provider: AgentProviderSettings,
): string | undefined {
  return provider.base_url ?? provider.baseURL;
}

/**
 * OpenAI and OpenAI-compatible credentials. `codex` copies `OPENAI_API_KEY`
 * into the `CODEX_API_KEY` its bridge reads; `opencode` reads it directly.
 */
export function resolveOpenAiAuthEnv(
  provider: AgentProviderSettings,
): HarnessV1AuthenticationEnvironment {
  const baseUrl = resolveHarnessProviderBaseUrl(provider);

  return {
    OPENAI_API_KEY: provider.apiKey!,
    ...(baseUrl ? { OPENAI_BASE_URL: baseUrl } : {}),
    ...(provider.organization
      ? { OPENAI_ORGANIZATION: provider.organization }
      : {}),
    ...(provider.project ? { OPENAI_PROJECT: provider.project } : {}),
  };
}
