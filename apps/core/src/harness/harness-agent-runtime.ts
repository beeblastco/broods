/**
 * AI SDK HarnessAgent construction over Broods-owned persistent sandboxes.
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
import { createMicrovmHarnessDriver } from "./sandbox/microvm-harness-driver.ts";
import { createWorkdirHarnessDriver } from "./sandbox/workdir-harness-driver.ts";
import type { SandboxExecutorConfig } from "./sandbox/types.ts";

const DEFAULT_HARNESS_BRIDGE_PORT = 4_321;
const ENSURE_PNPM_COMMAND =
  "command -v pnpm >/dev/null 2>&1 || npm install --global pnpm@10.34.5 --no-audit --no-fund";
const ENSURE_HARNESS_WORKSPACE_COMMAND = "mkdir -p /workspace";

export type HarnessKind = "claude-code" | "codex";
export type WorkdirHarnessKind = HarnessKind;

interface HarnessAgentCommonOptions {
  id?: string;
  reservationKey: string;
  bridgePort?: number;
  instructions?: string;
  permissionMode?: HarnessAgentPermissionMode;
  sandboxConfig?: HarnessAgentSandboxConfig;
  skills?: ReadonlyArray<HarnessAgentSkill>;
  tools?: ToolSet;
}

export type WorkdirHarnessAgentOptions =
  | (HarnessAgentCommonOptions & {
      compute: SandboxExecutorConfig & {
        provider: "sandbox";
        persistent: true;
      };
      harness: "claude-code";
      harnessSettings?: ClaudeCodeHarnessSettings;
    })
  | (HarnessAgentCommonOptions & {
      compute: SandboxExecutorConfig & {
        provider: "sandbox";
        persistent: true;
      };
      harness: "codex";
      harnessSettings?: CodexHarnessSettings;
    });

export type MicrovmHarnessAgentOptions =
  | (HarnessAgentCommonOptions & {
      compute: SandboxExecutorConfig & {
        provider: "lambda";
        persistent: true;
      };
      harness: "claude-code";
      harnessSettings?: ClaudeCodeHarnessSettings;
    })
  | (HarnessAgentCommonOptions & {
      compute: SandboxExecutorConfig & {
        provider: "lambda";
        persistent: true;
      };
      harness: "codex";
      harnessSettings?: CodexHarnessSettings;
    });

export interface HarnessAgentRuntime {
  agent: HarnessAgent<any, any>;
  bridgePort: number;
  reservationKey: string;
  sandbox: ReturnType<typeof createBroodsSandbox>;
}

export type WorkdirHarnessAgentRuntime = HarnessAgentRuntime;
export type MicrovmHarnessAgentRuntime = HarnessAgentRuntime;

export function createWorkdirHarnessAgent(
  options: WorkdirHarnessAgentOptions,
): WorkdirHarnessAgentRuntime {
  const bridgePort = options.bridgePort ?? DEFAULT_HARNESS_BRIDGE_PORT;
  const reservationKey = versionScopedReservationKey(
    options.reservationKey,
    options.harness,
  );
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
  const agent = createHarnessAgent(options, sandbox);

  return { agent, bridgePort, reservationKey, sandbox };
}

export function createMicrovmHarnessAgent(
  options: MicrovmHarnessAgentOptions,
): MicrovmHarnessAgentRuntime {
  const bridgePort = options.bridgePort ?? DEFAULT_HARNESS_BRIDGE_PORT;
  const reservationKey = versionScopedReservationKey(
    options.reservationKey,
    options.harness,
  );
  const compute = {
    ...options.compute,
    onCreate: [
      ENSURE_HARNESS_WORKSPACE_COMMAND,
      ENSURE_PNPM_COMMAND,
      ...(options.compute.onCreate ?? []),
    ],
  };
  const sandbox = createBroodsSandbox({
    driver: createMicrovmHarnessDriver({
      reservationKey,
      config: compute,
      ports: [bridgePort],
    }),
    providerId: `broods-microvm-${options.harness}`,
    bridgePorts: [bridgePort],
  });
  const agent = createHarnessAgent(options, sandbox);

  return { agent, bridgePort, reservationKey, sandbox };
}

export function workdirHarnessVersion(kind: WorkdirHarnessKind): string {
  return harnessVersion(kind);
}

export function microvmHarnessVersion(kind: HarnessKind): string {
  return harnessVersion(kind);
}

function harnessVersion(kind: HarnessKind): string {
  return kind === "claude-code"
    ? CLAUDE_CODE_HARNESS_VERSION
    : CODEX_HARNESS_VERSION;
}

function versionScopedReservationKey(
  reservationKey: string,
  kind: HarnessKind,
): string {
  return `${reservationKey}:${kind}:${harnessVersion(kind)}`;
}

function createHarnessAgent(
  options: WorkdirHarnessAgentOptions | MicrovmHarnessAgentOptions,
  sandbox: ReturnType<typeof createBroodsSandbox>,
): HarnessAgent<any, any> {
  const harness =
    options.harness === "claude-code"
      ? createClaudeCode(options.harnessSettings)
      : createCodex(options.harnessSettings);

  if (
    options.harness === "codex" &&
    options.permissionMode !== undefined &&
    options.permissionMode !== "allow-all"
  ) {
    throw new Error("Codex Harness requires permissionMode allow-all");
  }

  return new HarnessAgent({
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
}
