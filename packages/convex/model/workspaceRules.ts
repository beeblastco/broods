/**
 * Workspace-config validation for the Convex config plane. Ports core's
 * former storage/workspace-config.ts normalizer so the public /v1/workspaces
 * contract is unchanged. Workspace config holds no secrets (a roleArn is not
 * a secret), so it is stored and returned in plaintext. Pure module, safe
 * for the default Convex runtime. The public projection lives in
 * ./responses.ts. Core runs the same storage access rule when it resolves a
 * mount, so that rule reads the env names of both sides.
 */

import { assertPublicHttpsUrl } from "./agentRules";
import { mergeConfigObjects } from "./configValues";
import { isPlainObject } from "./objects";

const FILESYSTEM_NAMESPACE_PREFIX = "fs-";
const HASH_HEX_LENGTH = 40;
// Env names that hold a platform bucket, on the config plane or on core.
const PLATFORM_BUCKET_ENV_NAMES = [
  "FILESYSTEM_BUCKET_NAME",
  "SKILLS_BUCKET_NAME",
  "TOOL_BUNDLES_BUCKET_NAME",
  "MICROVM_ARTIFACTS_BUCKET_NAME",
] as const;
// Env names that hold a platform role ARN. Their account id, plus
// AWS_ACCOUNT_ID when set, is the platform account.
const PLATFORM_ROLE_ARN_ENV_NAMES = [
  "CONVEX_AWS_ROLE_ARN",
  "SANDBOX_MOUNT_ROLE_ARN",
  "MICROVM_EXECUTION_ROLE_ARN",
  "MICROVM_BUILD_ROLE_ARN",
] as const;
const ROLE_ARN_PATTERN = /^arn:[a-z-]+:iam::(\d+):role\/.+$/;

/** Per-file cap, enforced on the S3 write path and on dashboard uploads. */
export const MAX_WORKSPACE_FILE_BYTES = 512 * 1024;
export const WORKSPACE_STORAGE_PROVIDERS = ["s3"] as const;

export type WorkspaceStorageProvider =
  (typeof WORKSPACE_STORAGE_PROVIDERS)[number];

export type WorkspaceStorageAuth =
  | { type: "managed" }
  | { type: "assumeRole"; roleArn: string; externalId?: string };

/** The only auth that reaches a bucket the workspace names itself. */
export type WorkspaceStorageOwnAuth = Extract<
  WorkspaceStorageAuth,
  { type: "assumeRole" }
>;

export interface WorkspaceStorageConfig {
  provider: WorkspaceStorageProvider;
  bucket?: string;
  region?: string;
  endpoint?: string;
  prefix?: string;
  auth?: WorkspaceStorageAuth;
}

export interface WorkspaceConfig {
  storage: WorkspaceStorageConfig;
  isolation?: boolean;
  // Named harness features, each with its own options (no top-level enabled):
  // workspace = the <workspace> prompt, memory = structured memory.
  harness?: {
    workspace?: { enabled?: boolean };
    memory?: { enabled?: boolean };
  };
}

/**
 * A storage endpoint is a public https URL. A self-host operator allows private
 * endpoints with ALLOW_PRIVATE_STORAGE_ENDPOINTS=true.
 * @param value the endpoint URL
 * @param label the config path named in the error
 * @throws when the endpoint is not a public https URL
 */
export function assertStorageEndpoint(value: string, label: string): void {
  if (process.env.ALLOW_PRIVATE_STORAGE_ENDPOINTS === "true") return;
  assertPublicHttpsUrl(value, label);
}

/**
 * @param value the raw config value (null/undefined yields the s3 default)
 * @returns the normalized workspace config
 * @throws when a field is malformed or the storage provider is unsupported
 */
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

  let harness:
    | { workspace?: { enabled?: boolean }; memory?: { enabled?: boolean } }
    | undefined;
  if (config.harness !== undefined) {
    if (!isPlainObject(config.harness)) {
      throw new Error("config.harness must be an object");
    }
    const workspacePrompt = normalizeHarnessFeature(
      config.harness.workspace,
      "config.harness.workspace",
    );
    const memory = normalizeHarnessFeature(
      config.harness.memory,
      "config.harness.memory",
    );
    if (workspacePrompt || memory) {
      harness = {
        ...(workspacePrompt ? { workspace: workspacePrompt } : {}),
        ...(memory ? { memory: memory } : {}),
      };
    }
  }

  return {
    storage: storage,
    ...(isolation === true ? { isolation: true } : {}),
    ...(harness ? { harness: harness } : {}),
  };
}

/**
 * @param value the raw request body
 * @returns the normalized name/description/config
 * @throws when a field is missing or malformed
 */
export function normalizeCreateWorkspaceConfigInput(value: unknown): {
  name: string;
  description?: string;
  config: WorkspaceConfig;
} {
  if (!isPlainObject(value)) throw new Error("Request body must be an object");
  const name = requireString(value.name, "name");
  const description = optionalString(value.description, "description");
  const config = normalizeWorkspaceConfig(value.config);

  return {
    name: name,
    ...(description ? { description: description } : {}),
    config: config,
  };
}

/**
 * @param existingConfig the stored workspace config (merge base)
 * @param value the raw request body
 * @returns the normalized patch with the fully merged config
 * @throws when a field is malformed
 */
export function normalizeUpdateWorkspaceConfigInput(
  existingConfig: WorkspaceConfig,
  value: unknown,
): { name?: string; description?: string | null; config: WorkspaceConfig } {
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
    config: config,
  };
}

/**
 * A workspace that names its own bucket brings its own credentials; platform
 * credentials only ever reach the managed bucket. Runs at save time and again
 * wherever storage is resolved, so a stored row that breaks the rule fails closed.
 * @param storage the normalized workspace storage
 * @returns the bucket's own auth, or undefined for the managed bucket
 * @throws when a named bucket, its auth or its endpoint breaks the rule
 */
export function workspaceStorageOwnAuth(
  storage: WorkspaceStorageConfig,
): WorkspaceStorageOwnAuth | undefined {
  if (storage.endpoint) {
    if (!storage.bucket) {
      throw new Error(
        "config.storage.endpoint requires config.storage.bucket; the managed bucket has no custom endpoint",
      );
    }
    assertStorageEndpoint(storage.endpoint, "config.storage.endpoint");
  }
  if (!storage.bucket) return undefined;
  if (
    platformEnvValues(PLATFORM_BUCKET_ENV_NAMES).includes(
      storage.bucket.toLowerCase(),
    )
  ) {
    throw new Error(
      "config.storage.bucket must be a bucket you own; omit it to use the managed bucket",
    );
  }
  if (storage.auth?.type !== "assumeRole") {
    throw new Error(
      'config.storage.auth.type "assumeRole" is required when config.storage.bucket is set; a named bucket is only reached with its own credentials',
    );
  }
  const roleAccountId = ROLE_ARN_PATTERN.exec(storage.auth.roleArn)?.[1];
  if (!roleAccountId) {
    throw new Error("config.storage.auth.roleArn must be an IAM role ARN");
  }
  const platformAccountIds = [
    ...platformEnvValues(["AWS_ACCOUNT_ID"]),
    ...platformEnvValues(PLATFORM_ROLE_ARN_ENV_NAMES).map(
      (arn) => ROLE_ARN_PATTERN.exec(arn)?.[1],
    ),
  ];
  if (platformAccountIds.includes(roleAccountId)) {
    throw new Error(
      "config.storage.auth.roleArn must be a role in your own AWS account",
    );
  }

  return storage.auth;
}

/**
 * Derive a workspace's `fs-…` filesystem namespace. Matches core's
 * normalizeFilesystemNamespace byte-for-byte: S3 keys live under this prefix
 * and workspace-bound sandbox reservation keys are the namespace itself or
 * namespace-prefixed. Uses Web Crypto so it bundles for any Convex runtime.
 * @param accountId account owning the workspace
 * @param workspaceId the workspace config id
 * @returns the `fs-…` namespace prefix
 */
export async function workspaceNamespace(
  accountId: string,
  workspaceId: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `filesystem-namespace\0${accountId}:${workspaceId}`,
    ),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return `${FILESYSTEM_NAMESPACE_PREFIX}${hex.slice(0, HASH_HEX_LENGTH)}`;
}

/**
 * Validate and normalize a workspace-relative file path. Lives here rather than
 * in model/workspaceFs so the default-runtime HTTP surface can reuse it without
 * pulling the S3 client into a non-node bundle.
 * @param value candidate path
 * @returns the normalized path
 * @throws when the path is empty or contains traversal segments
 */
export function normalizeFilePath(value: unknown): string {
  if (typeof value !== "string") throw new Error("path is required");
  const path = value.trim().replace(/^\/+|\/+$/g, "");
  const parts = path.split("/");
  if (
    !path ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  )
    throw new Error("Invalid workspace file path");

  return path;
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

function normalizeHarnessFeature(
  value: unknown,
  name: string,
): { enabled?: boolean } | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw new Error(`${name} must be an object`);
  }
  assertOptionalBoolean(value.enabled, `${name}.enabled`);

  // Features default to on: `enabled: true` normalizes away to the omitted form.
  return value.enabled === false ? { enabled: false } : undefined;
}

function normalizeWorkspaceStorage(value: unknown): WorkspaceStorageConfig {
  if (value === undefined) {
    return { provider: "s3" };
  }
  if (!isPlainObject(value)) {
    throw new Error("config.storage must be an object");
  }
  if (value.provider === "vercel") {
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
  if (bucket && !prefix?.replace(/^\/+|\/+$/g, "")) {
    throw new Error(
      "config.storage.prefix is required when config.storage.bucket is set; the sandbox mount is scoped to that prefix",
    );
  }
  const auth = normalizeWorkspaceStorageAuth(value.auth);
  const storage: WorkspaceStorageConfig = {
    provider: (value.provider as WorkspaceStorageProvider | undefined) ?? "s3",
    ...(bucket ? { bucket: bucket } : {}),
    ...(region ? { region: region } : {}),
    ...(endpoint ? { endpoint: endpoint } : {}),
    ...(prefix ? { prefix: prefix } : {}),
    ...(auth ? { auth: auth } : {}),
  };
  workspaceStorageOwnAuth(storage);

  return storage;
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
      roleArn: roleArn,
      ...(externalId ? { externalId: externalId } : {}),
    };
  }
  throw new Error(
    "config.storage.auth.type must be one of: managed, assumeRole",
  );
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

// Lowercased values of the named env vars that are set on this side.
function platformEnvValues(names: readonly string[]): string[] {
  return names.flatMap((name) => {
    const value = process.env[name]?.trim().toLowerCase();

    return value ? [value] : [];
  });
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value.trim();
}
