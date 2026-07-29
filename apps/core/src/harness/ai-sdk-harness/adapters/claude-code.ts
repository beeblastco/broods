/**
 * Claude Code adapter construction and Broods provider mapping.
 */

import {
  VERSION,
  createClaudeCode,
  type ClaudeCodeHarnessSettings,
} from "@ai-sdk/harness-claude-code";
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import type { AgentConfig } from "../../../shared/domain/agent-config.ts";
import {
  requireHarnessModelId,
  requireHarnessProviderName,
  requireHarnessProviderSettings,
  resolveAnthropicOrGatewayAuth,
} from "../provider.ts";

export const CLAUDE_CODE_HARNESS_VERSION = VERSION;

export function createClaudeCodeAdapter(
  settings?: ClaudeCodeHarnessSettings,
): HarnessAgentAdapter {
  return createClaudeCode(settings);
}

export function createConfiguredClaudeCodeAdapter(
  agentConfig: AgentConfig,
): HarnessAgentAdapter {
  const harness = agentConfig.harness!;
  const model = requireHarnessModelId(agentConfig);
  const providerName = requireHarnessProviderName(agentConfig);
  if (providerName !== "anthropic" && providerName !== "gateway") {
    throw new Error(
      "config.harness.type claude-code requires the anthropic or gateway model provider",
    );
  }
  const provider = requireHarnessProviderSettings(agentConfig, providerName);

  return createClaudeCode({
    auth: resolveAnthropicOrGatewayAuth(providerName, provider),
    maxTurns: agentConfig.agent?.maxTurn,
    model: model,
    startupTimeoutMs: harness.startupTimeoutMs,
  });
}
