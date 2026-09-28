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

// Adapter package versions; they scope sandbox reservation keys per version.
const HARNESS_VERSIONS: Record<AiSdkHarnessType, string> = {
  "claude-code": CLAUDE_CODE_HARNESS_VERSION,
  codex: CODEX_HARNESS_VERSION,
  deepagents: DEEPAGENTS_HARNESS_VERSION,
  opencode: OPENCODE_HARNESS_VERSION,
  pi: PI_HARNESS_VERSION,
};
// How a successful turn parks the native session: detach keeps the bridge alive,
// stop shuts it down. Both return the resume state the next turn starts from.
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

// Every adapter but Pi starts a bridge that binds one fixed port per machine, so
// two of its conversations cannot run on one machine at once.
const HARNESS_SHARES_SANDBOX: Record<AiSdkHarnessType, boolean> = {
  "claude-code": false,
  codex: false,
  deepagents: false,
  opencode: false,
  pi: true,
};

// Adapters whose running turn takes another user message (the prompt control's
// submitUserMessage). The rest read steering only when the next turn starts.
const HARNESS_MID_TURN_STEERING: Record<AiSdkHarnessType, boolean> = {
  "claude-code": true,
  codex: false,
  deepagents: false,
  opencode: true,
  pi: true,
};

/** Builds an adapter from raw harness settings; the Workdir and MicroVM agent factories use it, mostly in tests. */
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

/** Picks and builds the adapter for an agent's `harness.type`; `createConfiguredHarnessAgent` calls it on every run. */
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

/** The adapter package version; the sandbox layer scopes reservation keys with it. */
export function harnessAdapterVersion(type: AiSdkHarnessType): string {
  return HARNESS_VERSIONS[type];
}

/** Whether the running turn takes steering messages; the run loop in `harness.ts` checks it. */
export function harnessSteersMidTurn(type: AiSdkHarnessType): boolean {
  return HARNESS_MID_TURN_STEERING[type];
}

/** Whether a successful turn detaches or stops the native session; `parkAiSdkHarnessSession` reads it. */
export function harnessSessionParking(
  type: AiSdkHarnessType,
): AiSdkHarnessSessionParking {
  return HARNESS_SESSION_PARKING[type];
}

/** Whether conversations can share one machine; `harnessReservationKey` reads it. */
export function harnessSharesSandbox(type: AiSdkHarnessType): boolean {
  return HARNESS_SHARES_SANDBOX[type];
}
