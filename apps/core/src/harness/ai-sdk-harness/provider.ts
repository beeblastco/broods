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

// Adapters pass an isolated env that replaces the host env, so no core credential leaks in.
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

// Adapters take the gateway route whenever AI_GATEWAY_API_KEY is set; no mode flag needed.
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
