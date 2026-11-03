import type { HarnessV1AuthenticationEnvironment } from "@ai-sdk/harness";
import type {
  AgentConfig,
  AgentProviderSettings,
} from "../../shared/domain/agent-config.ts";
import { logWarn } from "../../shared/log.ts";

// Claude models without effort, per the AI SDK Anthropic model table; every later model has it.
export const CLAUDE_WITHOUT_EFFORT =
  /claude-(?:3|(?:haiku|sonnet)-4[.-]5|opus-4[.-]1|(?:opus|sonnet)-4(?:[.-]0|-20\d{6}|$))/;

type HarnessProviderName = NonNullable<
  NonNullable<AgentConfig["model"]>["provider"]
>;
type HarnessReasoning = NonNullable<AgentConfig["model"]>["reasoning"];
type HarnessEffort = "low" | "medium" | "high" | "xhigh";

interface AnthropicHarnessReasoning {
  effort?: Exclude<HarnessEffort, "xhigh">;
}

// Claude Code and Deep Agents take Anthropic effort. Current Claude models refuse thinking off
// and older ones refuse xhigh, so those run as low and high, which every effort model takes.
export function anthropicHarnessReasoning(
  agentConfig: AgentConfig,
): AnthropicHarnessReasoning {
  const reasoning = agentConfig.model?.reasoning;
  const level = reasoning === "none" ? "low" : harnessEffort(reasoning);
  const effort = CLAUDE_WITHOUT_EFFORT.test(agentConfig.model?.modelId ?? "")
    ? undefined
    : level === "xhigh"
      ? "high"
      : level;
  warnReasoningChanged(agentConfig, effort);

  return effort ? { effort: effort } : {};
}

// The effort levels Claude Code, Deep Agents and Codex share; `minimal` is below their lowest.
export function harnessEffort(
  reasoning: HarnessReasoning,
): HarnessEffort | undefined {
  if (reasoning === "minimal") return "low";

  return reasoning === "low" ||
    reasoning === "medium" ||
    reasoning === "high" ||
    reasoning === "xhigh"
    ? reasoning
    : undefined;
}

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

// Tells the account's logs when the harness runs a different level than `model.reasoning` asks.
export function warnReasoningChanged(
  agentConfig: AgentConfig,
  sent: string | undefined,
): void {
  const configured = agentConfig.model?.reasoning;
  if (!configured || configured === "provider-default" || configured === sent) {
    return;
  }
  const runsAs = sent ? `"${sent}"` : "the model's default";
  logWarn(
    `model.reasoning "${configured}" runs as ${runsAs} on harness ` +
      `${agentConfig.harness?.type} with model ${agentConfig.model?.modelId}, ` +
      `the nearest level it takes`,
    {
      eventType: "harness.reasoning_changed",
      configured: configured,
      harness: agentConfig.harness?.type,
      modelId: agentConfig.model?.modelId,
      sent: sent ?? null,
    },
  );
}
