/**
 * Shared sandbox configuration limits.
 * Keep app-level defaults and environment overrides here.
 */

import { optionalEnv } from "./env.ts";
import type { SandboxProvider } from "./storage/sandbox-config.ts";

const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;
const DEFAULT_MAX_OUTPUT_LIMIT_BYTES = 256 * 1024;

// Per-call ceilings differ by provider. The lambda provider runs an AWS Lambda
// MicroVM: a single blocking (synchronous) exec is bounded by the harness request
// budget (harness-processing timeout, ~10 min), and memory is the MicroVM size,
// capped at the 8 GB largest size. Detached background jobs are not bounded here —
// they run inside the long-lived VM (up to its 8 h max lifetime). The other
// persistent providers (sandbox/e2b/daytona) are operator-sized (no memory max here).
const LAMBDA_MAX_TIMEOUT_SECONDS = 600;
const LAMBDA_MAX_MEMORY_LIMIT_MB = 8192;
const PERSISTENT_MAX_TIMEOUT_SECONDS = 600;

// Reserved (long-lived) sandbox lifecycle defaults. A reserved sandbox stays
// running while in use and scales to 0 / stops after an idle cooldown, resuming
// on the next call (Fargate-style). These bound the account-configurable
// `lifecycle` block.
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 15 * 60;
export const MAX_IDLE_TIMEOUT_SECONDS = 7 * 24 * 60 * 60;
export const MAX_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
// Default hard-expiry backstop for a reserved sandbox when no maxLifetimeSeconds
// is set: an abandoned sandbox self-deletes after this long without use (the
// harness refreshes the expiry on every call). Prevents leaked compute/disk.
export const DEFAULT_RELEASE_GRACE_SECONDS = 7 * 24 * 60 * 60;
// Cap concurrent detached background jobs per reserved sandbox so a runaway agent
// cannot pin a sandbox busy (and defeat scale-to-0) with unbounded jobs.
export const MAX_CONCURRENT_BACKGROUND_JOBS = 10;

/**
 * The managed workspace bucket key prefix for a namespace — the single source of
 * truth for the on-bucket layout, shared by the harness-side S3 reads/writes and the
 * sandbox's own mount so they always see the same files. A namespace's files live
 * directly under `<namespace>/` (the namespace is itself the tenant-isolation
 * boundary the mount session policy scopes to). Pass the namespace the sandbox
 * receives; callers append their own trailing `/` and sub-path.
 */
export function workspaceNamespacePrefix(namespace: string): string {
  return namespace;
}

export interface ResolvedSandboxLifecycle {
  idleTimeoutSeconds: number;
  maxLifetimeSeconds?: number;
}

/**
 * Resolve a persistent sandbox's effective idle/expiry policy from its
 * account-configured `lifecycle` block, applying defaults. Used by the executors
 * (workdir standby, daytona autoStopInterval, e2b timeout).
 */
export function resolveSandboxLifecycle(
  lifecycle?: { idleTimeoutSeconds?: number; maxLifetimeSeconds?: number },
): ResolvedSandboxLifecycle {
  return {
    idleTimeoutSeconds: lifecycle?.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS,
    ...(lifecycle?.maxLifetimeSeconds !== undefined
      ? { maxLifetimeSeconds: lifecycle.maxLifetimeSeconds }
      : {}),
  };
}

export interface WorkspaceSandboxLimits {
  defaultTimeoutSeconds: number;
  defaultOutputLimitBytes: number;
  maxTimeoutSeconds: number;
  // Undefined => no harness-imposed memory ceiling (operator-sized providers).
  maxMemoryLimitMb?: number;
  maxOutputLimitBytes: number;
}

/**
 * Per-call sandbox limits for a provider. Defaults and output caps are universal
 * (they protect the harness Lambda); the timeout/memory *maxima* are provider-aware
 * because lambda (MicroVM) caps memory at the 8 GB largest size — the other
 * persistent providers are operator-sized. Output truncation always applies (output
 * is read back into the harness regardless of provider).
 */
export function workspaceSandboxLimits(provider: SandboxProvider = "lambda"): WorkspaceSandboxLimits {
  const isLambda = provider === "lambda";
  return {
    defaultTimeoutSeconds: positiveIntegerEnv("WORKSPACE_SANDBOX_DEFAULT_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS),
    defaultOutputLimitBytes: positiveIntegerEnv("WORKSPACE_SANDBOX_DEFAULT_OUTPUT_LIMIT_BYTES", DEFAULT_OUTPUT_LIMIT_BYTES),
    maxTimeoutSeconds: isLambda
      ? positiveIntegerEnv("WORKSPACE_SANDBOX_LAMBDA_MAX_TIMEOUT_SECONDS", LAMBDA_MAX_TIMEOUT_SECONDS)
      : positiveIntegerEnv("WORKSPACE_SANDBOX_MAX_TIMEOUT_SECONDS", PERSISTENT_MAX_TIMEOUT_SECONDS),
    ...(isLambda
      ? { maxMemoryLimitMb: positiveIntegerEnv("WORKSPACE_SANDBOX_LAMBDA_MAX_MEMORY_LIMIT_MB", LAMBDA_MAX_MEMORY_LIMIT_MB) }
      : {}),
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
