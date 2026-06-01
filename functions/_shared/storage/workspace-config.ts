/**
 * Workspace config: account-scoped, reusable workspace definitions referenced by
 * agents via `config.workspaces[].workspaceId`. A workspace is the persistent
 * S3-backed filesystem mounted into a sandbox; agents referencing the same
 * workspaceId share the same files. Holds no secrets, so it is stored in
 * plaintext (unlike sandbox config). Validation + the public projection live
 * here; the DynamoDB / Convex stores call these at create/update.
 */

import { mergeConfigObjects } from "./agent-config.ts";

export interface WorkspaceConfig {
  storage: { provider: "s3" };
  // Whether the workspace harness prompt (memory/tasks guidance) is injected.
  harness?: { enabled?: boolean };
}

export interface WorkspaceConfigRecord {
  accountId: string;
  workspaceId: string;
  name: string;
  description?: string;
  config: WorkspaceConfig;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkspaceConfigInput {
  name: string;
  description?: string;
  config: unknown;
}

export interface UpdateWorkspaceConfigInput {
  name?: string;
  description?: string | null;
  config?: unknown;
}

export function normalizeWorkspaceConfig(value: unknown): WorkspaceConfig {
  if (value == null) {
    return { storage: { provider: "s3" } };
  }
  if (!isPlainObject(value)) {
    throw new Error("config must be an object");
  }

  const config = value;
  if (config.storage !== undefined) {
    if (!isPlainObject(config.storage)) {
      throw new Error("config.storage must be an object");
    }
    assertOptionalEnum(config.storage.provider, "config.storage.provider", ["s3"]);
  }

  let harness: { enabled?: boolean } | undefined;
  if (config.harness !== undefined) {
    if (!isPlainObject(config.harness)) {
      throw new Error("config.harness must be an object");
    }
    assertOptionalBoolean(config.harness.enabled, "config.harness.enabled");
    if (config.harness.enabled !== undefined) {
      harness = { enabled: config.harness.enabled as boolean };
    }
  }

  return {
    storage: { provider: "s3" },
    ...(harness ? { harness } : {}),
  };
}

export function normalizeCreateWorkspaceConfigInput(
  value: CreateWorkspaceConfigInput,
): { name: string; description?: string; config: WorkspaceConfig } {
  if (!isPlainObject(value)) throw new Error("Request body must be an object");
  const name = requireString(value.name, "name");
  const description = optionalString(value.description, "description");
  const config = normalizeWorkspaceConfig(value.config);
  return { name, ...(description ? { description } : {}), config };
}

export function normalizeUpdateWorkspaceConfigInput(
  existingConfig: WorkspaceConfig,
  value: UpdateWorkspaceConfigInput,
): UpdateWorkspaceConfigInput & { config: WorkspaceConfig } {
  if (!isPlainObject(value)) throw new Error("Request body must be an object");

  const config = "config" in value
    ? normalizeWorkspaceConfig(mergeConfigObjects(existingConfig, asObject(value.config)))
    : existingConfig;

  return {
    ...(value.name !== undefined ? { name: requireString(value.name, "name") } : {}),
    ...(value.description !== undefined
      ? { description: value.description === null ? null : optionalString(value.description, "description") }
      : {}),
    config,
  };
}

export function toPublicWorkspaceConfig(record: WorkspaceConfigRecord): WorkspaceConfigRecord {
  // No secrets in workspace config — return as-is.
  return record;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error("config must be an object");
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertOptionalBoolean(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
}

function assertOptionalEnum<T extends string>(value: unknown, name: string, allowed: readonly T[]): void {
  if (value !== undefined && (typeof value !== "string" || !allowed.includes(value as T))) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
