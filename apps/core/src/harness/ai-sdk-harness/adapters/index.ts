/**
 * Registry for the AI SDK Harness adapters supported by Broods.
 */

import type { ClaudeCodeHarnessSettings } from "@ai-sdk/harness-claude-code";
import type { CodexHarnessSettings } from "@ai-sdk/harness-codex";
import type { DeepAgentsHarnessSettings } from "@ai-sdk/harness-deepagents";
import type { OpenCodeHarnessSettings } from "@ai-sdk/harness-opencode";
import type { PiHarnessSettings } from "@ai-sdk/harness-pi";
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import type {
  AgentConfig,
  AgentHarnessConfig,
} from "../../../shared/domain/agent-config.ts";
import {
  CLAUDE_CODE_HARNESS_VERSION,
  createClaudeCodeAdapter,
  createConfiguredClaudeCodeAdapter,
} from "./claude-code.ts";
import {
  CODEX_HARNESS_VERSION,
  createCodexAdapter,
  createConfiguredCodexAdapter,
} from "./codex.ts";
import {
  DEEPAGENTS_HARNESS_VERSION,
  createConfiguredDeepAgentsAdapter,
  createDeepAgentsAdapter,
} from "./deepagents.ts";
import {
  OPENCODE_HARNESS_VERSION,
  createConfiguredOpenCodeAdapter,
  createOpenCodeAdapter,
} from "./opencode.ts";
import {
  PI_HARNESS_VERSION,
  createConfiguredPiAdapter,
  createPiAdapter,
} from "./pi.ts";

export type AiSdkHarnessType = AgentHarnessConfig["type"];
export type AiSdkHarnessSettings =
  | ClaudeCodeHarnessSettings
  | CodexHarnessSettings
  | DeepAgentsHarnessSettings
  | OpenCodeHarnessSettings
  | PiHarnessSettings;
export type AiSdkHarnessSessionParking = "detach" | "stop";

const HARNESS_VERSIONS: Record<AiSdkHarnessType, string> = {
  "claude-code": CLAUDE_CODE_HARNESS_VERSION,
  codex: CODEX_HARNESS_VERSION,
  deepagents: DEEPAGENTS_HARNESS_VERSION,
  opencode: OPENCODE_HARNESS_VERSION,
  pi: PI_HARNESS_VERSION,
};
const HARNESS_SESSION_PARKING: Record<
  AiSdkHarnessType,
  AiSdkHarnessSessionParking
> = {
  "claude-code": "stop",
  codex: "stop",
  deepagents: "detach",
  opencode: "stop",
  pi: "stop",
};

export function createAiSdkHarnessAdapter(
  type: AiSdkHarnessType,
  settings?: AiSdkHarnessSettings,
): HarnessAgentAdapter {
  if (type === "claude-code") {
    return createClaudeCodeAdapter(
      settings as ClaudeCodeHarnessSettings | undefined,
    );
  }
  if (type === "codex") {
    return createCodexAdapter(settings as CodexHarnessSettings | undefined);
  }
  if (type === "deepagents") {
    return createDeepAgentsAdapter(
      settings as DeepAgentsHarnessSettings | undefined,
    );
  }
  if (type === "opencode") {
    return createOpenCodeAdapter(
      settings as OpenCodeHarnessSettings | undefined,
    );
  }

  return createPiAdapter(settings as PiHarnessSettings | undefined);
}

export function createConfiguredAiSdkHarnessAdapter(
  agentConfig: AgentConfig,
): HarnessAgentAdapter {
  const type = agentConfig.harness?.type;
  if (!type) {
    throw new Error("config.harness is required");
  }
  if (type === "claude-code") {
    return createConfiguredClaudeCodeAdapter(agentConfig);
  }
  if (type === "codex") {
    return createConfiguredCodexAdapter(agentConfig);
  }
  if (type === "deepagents") {
    return createConfiguredDeepAgentsAdapter(agentConfig);
  }
  if (type === "opencode") {
    return createConfiguredOpenCodeAdapter(agentConfig);
  }

  return createConfiguredPiAdapter(agentConfig);
}

export function harnessAdapterVersion(type: AiSdkHarnessType): string {
  return HARNESS_VERSIONS[type];
}

export function harnessSessionParking(
  type: AiSdkHarnessType,
): AiSdkHarnessSessionParking {
  return HARNESS_SESSION_PARKING[type];
}
