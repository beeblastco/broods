/**
 * Workspace config: account-scoped, reusable workspace definitions referenced by
 * agents via `config.workspaces[].workspaceId`. A workspace is the persistent
 * S3-backed filesystem mounted into a sandbox; agents referencing the same
 * workspaceId share the same files. Holds no secrets, so it is stored in
 * plaintext (unlike sandbox config). Validation and the public projection live
 * here.
 */

import { logError } from "../log.ts";
import { isPlainObject } from "../object.ts";
import { mergeConfigObjects } from "./agent-config.ts";

// Implemented storage backends. The roadmap adds more (s3-compatible endpoints,
// Cloudflare R2, Google Cloud Storage, Azure Blob): extend this list and wire the
// provider's mount/read path — validation and the type follow automatically.
export const WORKSPACE_STORAGE_PROVIDERS = ["s3"] as const;
export type WorkspaceStorageProvider =
  (typeof WORKSPACE_STORAGE_PROVIDERS)[number];

// How the harness authenticates to the workspace bucket. `managed` (default) uses
// the broods-operated bucket + platform role. `assumeRole` is the bring-your-own
// bucket path: the harness assumes a cross-account role the developer controls —
// keyless, scoped to their bucket, paired with an ExternalId in their role's trust
// policy. Static-key auth for non-AWS S3-compatible stores is not modeled here yet
// (no account secret store); those still rely on the sandbox's encrypted envVars.
export type WorkspaceStorageAuth =
  | { type: "managed" }
  | { type: "assumeRole"; roleArn: string; externalId?: string };

// Storage identity for a workspace's S3-backed filesystem. All fields optional:
// omit `bucket` to use the broods-managed bucket (the default). `endpoint` selects
// an S3-compatible vendor (R2/MinIO/...) within provider "s3"; `prefix` scopes the
// mount to a sub-path of a bring-your-own bucket. Holds no secrets (a roleArn is
// not a secret), so workspace config stays plaintext.
export interface WorkspaceStorageConfig {
  provider: WorkspaceStorageProvider;
  bucket?: string;
  region?: string;
  endpoint?: string;
  prefix?: string;
  auth?: WorkspaceStorageAuth;
}

// The workspace harness is a set of named features, each with its own options
// and each defaulting to on. There is deliberately no top-level enabled flag:
// new capabilities get their own key here for independent control.
//   - workspace: the injected <workspace> prompt (file-tool + TASKS guidance).
//   - memory: structured memory — the memory_save tool, memory/MEMORY.md index
//     loading, and the <memory> prompt.
export interface WorkspaceHarnessConfig {
  workspace?: { enabled?: boolean };
  memory?: { enabled?: boolean };
}

export interface WorkspaceConfig {
  storage: WorkspaceStorageConfig;
  // Enables hierarchical alias-scoped workspace folders. Channel configs must
  // provide workspaceScope when an attached workspace sets this to true.
  isolation?: boolean;
  harness?: WorkspaceHarnessConfig;
}

/** Whether the <workspace> guidance prompt is injected for a workspace (default: on). */
export function workspaceGuidanceEnabled(config: WorkspaceConfig | undefined): boolean {
  return config?.harness?.workspace?.enabled !== false;
}

/** Whether the structured memory harness is on for a workspace (default: on). */
export function workspaceMemoryHarnessEnabled(config: WorkspaceConfig | undefined): boolean {
  return config?.harness?.memory?.enabled !== false;
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
  const storage = normalizeWorkspaceStorage(config.storage);
  assertOptionalBoolean(config.isolation, "config.isolation");
  const isolation = config.isolation as boolean | undefined;

  let harness: WorkspaceHarnessConfig | undefined;
  if (config.harness !== undefined) {
    if (!isPlainObject(config.harness)) {
      throw new Error("config.harness must be an object");
    }
    const workspace = normalizeHarnessFeature(config.harness.workspace, "config.harness.workspace");
    const memory = normalizeHarnessFeature(config.harness.memory, "config.harness.memory");
    if (workspace || memory) {
      harness = {
        ...(workspace ? { workspace } : {}),
        ...(memory ? { memory } : {}),
      };
    }
  }

  return {
    storage,
    ...(isolation === true ? { isolation: true } : {}),
    ...(harness ? { harness } : {}),
  };
}

function normalizeHarnessFeature(value: unknown, name: string): { enabled?: boolean } | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw new Error(`${name} must be an object`);
  }
  assertOptionalBoolean(value.enabled, `${name}.enabled`);
  return value.enabled !== undefined ? { enabled: value.enabled as boolean } : undefined;
}

function normalizeWorkspaceStorage(value: unknown): WorkspaceStorageConfig {
  if (value === undefined) {
    return { provider: "s3" };
  }
  if (!isPlainObject(value)) {
    throw new Error("config.storage must be an object");
  }
  if (value.provider === "vercel") {
    logError("Unsupported workspace storage provider rejected", {
      provider: "vercel",
      reason: "Vercel Drive workspace storage is not wired yet",
    });
    throw new Error(
      'config.storage.provider "vercel" is not supported yet; Vercel Drive workspace storage is not wired. Use "s3" or omit config.storage.',
    );
  }
  assertOptionalEnum(
    value.provider,
    "config.storage.provider",
    WORKSPACE_STORAGE_PROVIDERS,
  );

  const bucket = optionalString(value.bucket, "config.storage.bucket");
  const region = optionalString(value.region, "config.storage.region");
  const endpoint = optionalString(value.endpoint, "config.storage.endpoint");
  const prefix = optionalString(value.prefix, "config.storage.prefix");
  const auth = normalizeWorkspaceStorageAuth(value.auth);
  return {
    provider: (value.provider as WorkspaceStorageProvider | undefined) ?? "s3",
    ...(bucket ? { bucket } : {}),
    ...(region ? { region } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(prefix ? { prefix } : {}),
    ...(auth ? { auth } : {}),
  };
}

function normalizeWorkspaceStorageAuth(
  value: unknown,
): WorkspaceStorageAuth | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw new Error("config.storage.auth must be an object");
  }
  if (value.type === "managed") {
    return { type: "managed" };
  }
  if (value.type === "assumeRole") {
    const roleArn = requireString(value.roleArn, "config.storage.auth.roleArn");
    const externalId = optionalString(
      value.externalId,
      "config.storage.auth.externalId",
    );
    return {
      type: "assumeRole",
      roleArn,
      ...(externalId ? { externalId } : {}),
    };
  }
  throw new Error(
    "config.storage.auth.type must be one of: managed, assumeRole",
  );
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

  const config =
    "config" in value
      ? normalizeWorkspaceConfig(
          mergeConfigObjects(existingConfig, asObject(value.config)),
        )
      : existingConfig;

  return {
    ...(value.name !== undefined
      ? { name: requireString(value.name, "name") }
      : {}),
    ...(value.description !== undefined
      ? {
          description:
            value.description === null
              ? null
              : optionalString(value.description, "description"),
        }
      : {}),
    config,
  };
}

export function toPublicWorkspaceConfig(
  record: WorkspaceConfigRecord,
): WorkspaceConfigRecord {
  // No secrets in workspace config — return as-is.
  return record;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error("config must be an object");
  return value;
}

function assertOptionalBoolean(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
}

function assertOptionalEnum<T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
): void {
  if (
    value !== undefined &&
    (typeof value !== "string" || !allowed.includes(value as T))
  ) {
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
