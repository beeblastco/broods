/**
 * Shared sandbox configuration limits.
 * Keep app-level defaults and environment overrides here.
 */

import { optionalEnv } from "./env.ts";

// The sandbox lambdas mount the workspace bucket through an S3 Files access point
// rooted at this sub-path (SandboxS3FilesAccessPoint.rootDirectories in sst.config.ts).
// A sub-path is required because the access point's creationPermissions only make a
// directory it *creates* writable — the bucket root is not. The mount therefore stores
// files under this key prefix, so every harness-side S3 read/write of workspace files
// must apply the same prefix or it will not see what the sandbox wrote (and vice versa).
export const WORKSPACE_MOUNT_PREFIX = "sandbox";

const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;
const DEFAULT_MAX_TIMEOUT_SECONDS = 120;
const DEFAULT_MAX_MEMORY_LIMIT_MB = 1024;
const DEFAULT_MAX_OUTPUT_LIMIT_BYTES = 256 * 1024;

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
