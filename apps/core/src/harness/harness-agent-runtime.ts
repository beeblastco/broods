/**
 * Workdir-backed AI SDK HarnessAgent construction.
 * The main agent loop selects this runtime in a later integration slice.
 */

import {
  HarnessAgent,
  type HarnessAgentPermissionMode,
  type HarnessAgentSandboxConfig,
  type HarnessAgentSkill,
} from "@ai-sdk/harness/agent";
import {
  createClaudeCode,
  VERSION as CLAUDE_CODE_HARNESS_VERSION,
  type ClaudeCodeHarnessSettings,
} from "@ai-sdk/harness-claude-code";
import {
  createCodex,
  VERSION as CODEX_HARNESS_VERSION,
  type CodexHarnessSettings,
} from "@ai-sdk/harness-codex";
import { createBroodsSandbox } from "@broods/ai-sdk-sandbox";
import type { ToolSet } from "ai";
import { createWorkdirHarnessDriver } from "./sandbox/workdir-harness-driver.ts";
import type { SandboxExecutorConfig } from "./sandbox/types.ts";

const DEFAULT_HARNESS_BRIDGE_PORT = 4_321;
const ENSURE_PNPM_COMMAND =
  "command -v pnpm >/dev/null 2>&1 || npm install --global pnpm@10.34.5 --no-audit --no-fund";

export type WorkdirHarnessKind = "claude-code" | "codex";

interface WorkdirHarnessAgentCommonOptions {
  id?: string;
  reservationKey: string;
  compute: SandboxExecutorConfig & {
    provider: "sandbox";
    persistent: true;
  };
  bridgePort?: number;
  instructions?: string;
  permissionMode?: HarnessAgentPermissionMode;
  sandboxConfig?: HarnessAgentSandboxConfig;
  skills?: ReadonlyArray<HarnessAgentSkill>;
  tools?: ToolSet;
}

export type WorkdirHarnessAgentOptions =
  | (WorkdirHarnessAgentCommonOptions & {
      harness: "claude-code";
      harnessSettings?: ClaudeCodeHarnessSettings;
    })
  | (WorkdirHarnessAgentCommonOptions & {
      harness: "codex";
      harnessSettings?: CodexHarnessSettings;
    });

export interface WorkdirHarnessAgentRuntime {
  agent: HarnessAgent<any, any>;
  bridgePort: number;
  reservationKey: string;
  sandbox: ReturnType<typeof createBroodsSandbox>;
}

export function createWorkdirHarnessAgent(
  options: WorkdirHarnessAgentOptions,
): WorkdirHarnessAgentRuntime {
  const bridgePort = options.bridgePort ?? DEFAULT_HARNESS_BRIDGE_PORT;
  const version = workdirHarnessVersion(options.harness);
  const reservationKey = `${options.reservationKey}:${options.harness}:${version}`;
  const compute = {
    ...options.compute,
    onCreate: [ENSURE_PNPM_COMMAND, ...(options.compute.onCreate ?? [])],
  };
  const sandbox = createBroodsSandbox({
    driver: createWorkdirHarnessDriver({
      reservationKey,
      config: compute,
      ports: [bridgePort],
    }),
    providerId: `broods-workdir-${options.harness}`,
    bridgePorts: [bridgePort],
  });
  const harness =
    options.harness === "claude-code"
      ? createClaudeCode(options.harnessSettings)
      : createCodex(options.harnessSettings);

  if (options.harness === "codex" && options.permissionMode !== undefined) {
    if (options.permissionMode !== "allow-all") {
      throw new Error("Codex Harness requires permissionMode allow-all");
    }
  }

  const agent = new HarnessAgent({
    harness,
    sandbox,
    ...(options.id !== undefined ? { id: options.id } : {}),
    ...(options.instructions !== undefined
      ? { instructions: options.instructions }
      : {}),
    ...(options.permissionMode !== undefined
      ? { permissionMode: options.permissionMode }
      : {}),
    ...(options.sandboxConfig !== undefined
      ? { sandboxConfig: options.sandboxConfig }
      : {}),
    ...(options.skills !== undefined ? { skills: options.skills } : {}),
    ...(options.tools !== undefined ? { tools: options.tools } : {}),
  });

  return { agent, bridgePort, reservationKey, sandbox };
}

export function workdirHarnessVersion(kind: WorkdirHarnessKind): string {
  return kind === "claude-code"
    ? CLAUDE_CODE_HARNESS_VERSION
    : CODEX_HARNESS_VERSION;
}
