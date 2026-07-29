/**
 * Persistent Workdir and MicroVM provisioning for AI SDK Harness sessions.
 */

import { createBroodsSandbox } from "@broods/ai-sdk-sandbox";
import { createMicrovmHarnessDriver } from "../sandbox/microvm-harness-driver.ts";
import type { SandboxExecutorConfig } from "../sandbox/types.ts";
import { createWorkdirHarnessDriver } from "../sandbox/workdir-harness-driver.ts";
import {
  harnessAdapterVersion,
  type AiSdkHarnessType,
} from "./adapters/index.ts";

const DEFAULT_HARNESS_BRIDGE_PORT = 4_321;
const ENSURE_HARNESS_WORKSPACE_COMMAND = "mkdir -p /workspace";
const ENSURE_PNPM_COMMAND =
  "command -v pnpm >/dev/null 2>&1 || npm install --global pnpm@10.34.5 --no-audit --no-fund";

export type AiSdkHarnessCompute =
  | (SandboxExecutorConfig & { provider: "sandbox"; persistent: true })
  | (SandboxExecutorConfig & { provider: "lambda"; persistent: true });

export interface AiSdkHarnessSandbox {
  bridgePort: number;
  reservationKey: string;
  sandbox: ReturnType<typeof createBroodsSandbox>;
}

export interface AiSdkHarnessSandboxOptions {
  bridgePort?: number;
  compute: AiSdkHarnessCompute;
  reservationKey: string;
  type: AiSdkHarnessType;
}

export function createAiSdkHarnessSandbox(
  options: AiSdkHarnessSandboxOptions,
): AiSdkHarnessSandbox {
  return options.compute.provider === "lambda"
    ? createMicrovmHarnessSandbox({
        ...options,
        compute: options.compute,
      })
    : createWorkdirHarnessSandbox({
        ...options,
        compute: options.compute,
      });
}

export function harnessRuntimeVersion(type: AiSdkHarnessType): string {
  return harnessAdapterVersion(type);
}

export function requireAiSdkHarnessCompute(
  compute: SandboxExecutorConfig,
): AiSdkHarnessCompute {
  if (
    (compute.provider !== "sandbox" && compute.provider !== "lambda") ||
    compute.persistent !== true
  ) {
    throw new Error(
      "config.harness requires a persistent sandbox using the sandbox or lambda provider",
    );
  }

  return compute as AiSdkHarnessCompute;
}

function createMicrovmHarnessSandbox(
  options: AiSdkHarnessSandboxOptions & {
    compute: Extract<AiSdkHarnessCompute, { provider: "lambda" }>;
  },
): AiSdkHarnessSandbox {
  const bridgePort = options.bridgePort ?? DEFAULT_HARNESS_BRIDGE_PORT;
  const reservationKey = versionScopedReservationKey(
    options.reservationKey,
    options.type,
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
      reservationKey: reservationKey,
      config: compute,
      ports: [bridgePort],
    }),
    providerId: `broods-microvm-${options.type}`,
    bridgePorts: [bridgePort],
  });

  return {
    bridgePort: bridgePort,
    reservationKey: reservationKey,
    sandbox: sandbox,
  };
}

function createWorkdirHarnessSandbox(
  options: AiSdkHarnessSandboxOptions & {
    compute: Extract<AiSdkHarnessCompute, { provider: "sandbox" }>;
  },
): AiSdkHarnessSandbox {
  const bridgePort = options.bridgePort ?? DEFAULT_HARNESS_BRIDGE_PORT;
  const reservationKey = versionScopedReservationKey(
    options.reservationKey,
    options.type,
  );
  const compute = {
    ...options.compute,
    onCreate: [ENSURE_PNPM_COMMAND, ...(options.compute.onCreate ?? [])],
  };
  const sandbox = createBroodsSandbox({
    driver: createWorkdirHarnessDriver({
      reservationKey: reservationKey,
      config: compute,
      ports: [bridgePort],
    }),
    providerId: `broods-workdir-${options.type}`,
    bridgePorts: [bridgePort],
  });

  return {
    bridgePort: bridgePort,
    reservationKey: reservationKey,
    sandbox: sandbox,
  };
}

function versionScopedReservationKey(
  reservationKey: string,
  type: AiSdkHarnessType,
): string {
  return `${reservationKey}:${type}:${harnessAdapterVersion(type)}`;
}
