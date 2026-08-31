/**
 * Deep Agents adapter construction and Broods provider mapping.
 */

import {
  VERSION,
  createDeepAgents,
  type DeepAgentsHarnessSettings,
} from "@ai-sdk/harness-deepagents";
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import type { AgentConfig } from "../../../shared/domain/agent-config.ts";
import {
  requireHarnessModelId,
  requireHarnessProviderName,
  requireHarnessProviderSettings,
  resolveAnthropicOrVercelAuthEnv,
} from "../provider.ts";

export const DEEPAGENTS_HARNESS_VERSION = VERSION;

export function createConfiguredDeepAgentsAdapter(
  agentConfig: AgentConfig,
): HarnessAgentAdapter {
  const harness = agentConfig.harness!;
  const model = requireHarnessModelId(agentConfig);
  const providerName = requireHarnessProviderName(agentConfig);
  if (providerName !== "anthropic" && providerName !== "vercel") {
    throw new Error(
      "config.harness.type deepagents requires the anthropic or vercel model provider",
    );
  }
  const provider = requireHarnessProviderSettings(agentConfig, providerName);

  return createDeepAgents({
    auth: resolveAnthropicOrVercelAuthEnv(providerName, provider),
    model: model,
    recursionLimit: agentConfig.agent?.maxTurn,
    startupTimeoutMs: harness.startupTimeoutMs,
  });
}

export function createDeepAgentsAdapter(
  settings?: DeepAgentsHarnessSettings,
): HarnessAgentAdapter {
  return createDeepAgents(settings);
}
