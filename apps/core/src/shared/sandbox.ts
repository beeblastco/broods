import { workspaceSandboxLimits as configPlaneLimits } from "@broods/convex/model/sandboxRules";
import type { SandboxProvider } from "./domain/sandbox-config.ts";
import { optionalEnv } from "./env.ts";

const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;

export const DEFAULT_IDLE_TIMEOUT_SECONDS = 15 * 60;
// Keep equal to SANDBOX_RESERVATION_TTL_SECONDS in `packages/convex/runtime.ts`.
export const DEFAULT_RELEASE_GRACE_SECONDS = 7 * 24 * 60 * 60;
export const MAX_CONCURRENT_BACKGROUND_JOBS = 10;

export interface ResolvedSandboxLifecycle {
  idleTimeoutSeconds: number;
  maxLifetimeSeconds?: number;
}

export interface WorkspaceSandboxLimits {
  defaultTimeoutSeconds: number;
  defaultOutputLimitBytes: number;
  maxTimeoutSeconds: number;
  maxOutputLimitBytes: number;
}

export function outlivedMaxLifetime(
  lifecycle: ResolvedSandboxLifecycle,
  startedAtMs: number,
): boolean {
  return (
    lifecycle.maxLifetimeSeconds !== undefined &&
    Date.now() - startedAtMs >= lifecycle.maxLifetimeSeconds * 1000
  );
}

export function resolveSandboxLifecycle(lifecycle?: {
  idleTimeoutSeconds?: number;
  maxLifetimeSeconds?: number;
}): ResolvedSandboxLifecycle {
  return {
    idleTimeoutSeconds:
      lifecycle?.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS,
    ...(lifecycle?.maxLifetimeSeconds !== undefined
      ? { maxLifetimeSeconds: lifecycle.maxLifetimeSeconds }
      : {}),
  };
}

// Shared by harness S3 calls and the sandbox mount; callers append their own `/` and sub-path.
export function workspaceNamespacePrefix(namespace: string): string {
  return namespace;
}

export function workspaceSandboxLimits(
  provider: SandboxProvider = "lambda",
): WorkspaceSandboxLimits {
  return {
    defaultTimeoutSeconds: positiveIntegerEnv(
      "WORKSPACE_SANDBOX_DEFAULT_TIMEOUT_SECONDS",
      DEFAULT_TIMEOUT_SECONDS,
    ),
    defaultOutputLimitBytes: positiveIntegerEnv(
      "WORKSPACE_SANDBOX_DEFAULT_OUTPUT_LIMIT_BYTES",
      DEFAULT_OUTPUT_LIMIT_BYTES,
    ),
    ...configPlaneLimits(provider),
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
