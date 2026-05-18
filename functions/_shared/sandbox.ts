/**
 * Shared sandbox configuration limits.
 * Keep app-level defaults and environment overrides here.
 */

import { optionalEnv } from "./env.ts";

const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;
const DEFAULT_MAX_TIMEOUT_SECONDS = 120;
const DEFAULT_MAX_MEMORY_LIMIT_MB = 1024;
const DEFAULT_MAX_OUTPUT_LIMIT_BYTES = 256 * 1024;

export interface WorkspaceSandboxLimits {
  defaultTimeoutSeconds: number;
  defaultOutputLimitBytes: number;
  maxTimeoutSeconds: number;
  maxMemoryLimitMb: number;
  maxOutputLimitBytes: number;
}

export function workspaceSandboxLimits(): WorkspaceSandboxLimits {
  return {
    defaultTimeoutSeconds: positiveIntegerEnv("WORKSPACE_SANDBOX_DEFAULT_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS),
    defaultOutputLimitBytes: positiveIntegerEnv("WORKSPACE_SANDBOX_DEFAULT_OUTPUT_LIMIT_BYTES", DEFAULT_OUTPUT_LIMIT_BYTES),
    maxTimeoutSeconds: positiveIntegerEnv("WORKSPACE_SANDBOX_MAX_TIMEOUT_SECONDS", DEFAULT_MAX_TIMEOUT_SECONDS),
    maxMemoryLimitMb: positiveIntegerEnv("WORKSPACE_SANDBOX_MAX_MEMORY_LIMIT_MB", DEFAULT_MAX_MEMORY_LIMIT_MB),
    maxOutputLimitBytes: positiveIntegerEnv("WORKSPACE_SANDBOX_MAX_OUTPUT_LIMIT_BYTES", DEFAULT_MAX_OUTPUT_LIMIT_BYTES),
  };
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = optionalEnv(name);
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}
