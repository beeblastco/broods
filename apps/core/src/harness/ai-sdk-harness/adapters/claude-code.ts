/**
 * Claude Code adapter construction and Broods provider mapping.
 */

import {
  VERSION,
  createClaudeCode,
  type ClaudeCodeHarnessSettings,
} from "@ai-sdk/harness-claude-code";
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import {
  configuredMaxTurn,
  type AgentConfig,
} from "../../../shared/domain/agent-config.ts";
import {
  requireHarnessProviderName,
  requireHarnessProviderSettings,
  resolveAnthropicOrVercelAuthEnv,
} from "../provider.ts";

export const CLAUDE_CODE_HARNESS_VERSION = VERSION;

/** Builds the Claude Code adapter from raw settings; `createAiSdkHarnessAdapter` calls it. */
export function createClaudeCodeAdapter(
  settings?: ClaudeCodeHarnessSettings,
): HarnessAgentAdapter {
  return createClaudeCode(settings);
}

/** Builds the Claude Code adapter from an agent config; the adapter registry calls it for `harness.type` claude-code. */
export function createConfiguredClaudeCodeAdapter(
  agentConfig: AgentConfig,
): HarnessAgentAdapter {
  const harness = agentConfig.harness!;
  const providerName = requireHarnessProviderName(agentConfig);
  if (providerName !== "anthropic" && providerName !== "vercel") {
    throw new Error(
      "config.harness.type claude-code requires the anthropic or vercel model provider",
    );
  }
  const provider = requireHarnessProviderSettings(agentConfig, providerName);

  return createClaudeCode({
    auth: resolveAnthropicOrVercelAuthEnv(providerName, provider),
    maxTurns: configuredMaxTurn(agentConfig),
    startupTimeoutMs: harness.startupTimeoutMs,
  });
}
