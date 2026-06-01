/**
 * Shared sandbox configuration limits.
 * Keep app-level defaults and environment overrides here.
 */

import { optionalEnv } from "./env.ts";
import type { SandboxProvider } from "./storage/sandbox-config.ts";

// The sandbox lambdas mount the workspace bucket through an S3 Files access point
// rooted at this sub-path (SandboxS3FilesAccessPoint.rootDirectories in sst.config.ts).
// A sub-path is required because the access point's creationPermissions only make a
// directory it *creates* writable — the bucket root is not. The mount therefore stores
// files under this key prefix, so every harness-side S3 read/write of workspace files
// must apply the same prefix or it will not see what the sandbox wrote (and vice versa).
export const WORKSPACE_MOUNT_PREFIX = "sandbox";

const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;
const DEFAULT_MAX_OUTPUT_LIMIT_BYTES = 256 * 1024;

// Per-call ceilings differ by provider. The lambda provider is bounded by the
// deployed sandbox function's own timeout (5 min) and memory (512 MB); the lambda
// API also caps timeout_ms at 300000, so keep this in sync. Persistent providers
// (e2b/daytona/kubernetes) run long-lived, operator-sized sandboxes, so the harness
// only bounds a single blocking call by its own request budget (harness-processing
// timeout, 10 min) and leaves memory to the operator.
const LAMBDA_MAX_TIMEOUT_SECONDS = 300;
const LAMBDA_MAX_MEMORY_LIMIT_MB = 1024;
const PERSISTENT_MAX_TIMEOUT_SECONDS = 600;

/**
 * Build the workspace-bucket key prefix for a namespace, matching the path the
 * sandbox mount uses. Pass the namespace identifier the sandbox receives (do not
 * pre-prefix it — the mount adds this prefix via the access point root).
 */
export function workspaceNamespacePrefix(namespace: string): string {
  return `${WORKSPACE_MOUNT_PREFIX}/${namespace}`;
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
 * because only lambda is hard-bounded by its own function — persistent providers are
 * operator-sized. Output truncation always applies (output is read back into the
 * harness regardless of provider).
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
