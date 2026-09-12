/**
 * OpenCode adapter construction and Broods provider mapping.
 */

import {
  VERSION,
  createOpenCode,
  type OpenCodeHarnessSettings,
} from "@ai-sdk/harness-opencode";
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import type { AgentConfig } from "../../../shared/domain/agent-config.ts";
import {
  requireHarnessProviderName,
  requireHarnessProviderSettings,
  resolveAnthropicAuthEnv,
  resolveGatewayAuthEnv,
  resolveOpenAiAuthEnv,
} from "../provider.ts";

export const OPENCODE_HARNESS_VERSION = VERSION;

export function createConfiguredOpenCodeAdapter(
  agentConfig: AgentConfig,
): HarnessAgentAdapter {
  const harness = agentConfig.harness!;
  const providerName = requireHarnessProviderName(agentConfig);
  const provider = requireHarnessProviderSettings(agentConfig, providerName);
  // `custom` is absent on purpose: OpenCode discovers credentials by its own
  // provider name and resolves an unrecognized label to Anthropic, silently
  // dropping an OpenAI-compatible key.
  const auth =
    providerName === "anthropic"
      ? resolveAnthropicAuthEnv(provider)
      : providerName === "openai"
        ? resolveOpenAiAuthEnv(provider)
        : providerName === "vercel"
          ? resolveGatewayAuthEnv(provider)
          : undefined;
  if (!auth) {
    throw new Error(
      "config.harness.type opencode requires the anthropic, openai, or vercel model provider",
    );
  }
  const reasoning = agentConfig.model?.reasoning;

  return createOpenCode({
    auth: auth,
    provider: providerName,
    reasoningVariant: reasoning && reasoning !== "none" ? reasoning : undefined,
    startupTimeoutMs: harness.startupTimeoutMs,
  });
}

export function createOpenCodeAdapter(
  settings?: OpenCodeHarnessSettings,
): HarnessAgentAdapter {
  return createOpenCode(settings);
}
