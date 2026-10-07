/**
 * Workspace-config validation for the Convex config plane. Ports core's
 * former storage/workspace-config.ts normalizer so the public /v1/workspaces
 * contract is unchanged. Workspace config holds no secrets (a roleArn is not
 * a secret, and R2 keys are `${NAME}` env refs), so it is stored and returned
 * in plaintext. Pure module, safe
 * for the default Convex runtime. The public projection lives in
 * ./responses.ts. Core runs the storage access rule too, so it reads the env
 * names of both sides.
 */

import { assertPublicHttpsUrl, isPrivateHostname } from "./agentRules";
import { mergeConfigObjects } from "./configValues";
import {
  ACCOUNT_ENV_PLACEHOLDER_PATTERN,
  ACCOUNT_ENV_REF_PATTERN,
} from "./envRefs";
import { isPlainObject } from "./objects";
import { ClientError } from "./clientError";
import {
  WORKSPACE_ISOLATION_LEVELS,
  type WorkspaceIsolation,
} from "./workspaceIsolation";

const FILESYSTEM_NAMESPACE_PREFIX = "fs-";
const HASH_HEX_LENGTH = 40;
const PLATFORM_BUCKET_ENV_NAMES = [
  "FILESYSTEM_BUCKET_NAME",
  "SKILLS_BUCKET_NAME",
  "TOOL_BUNDLES_BUCKET_NAME",
  "MICROVM_ARTIFACTS_BUCKET_NAME",
];
// The account id inside these ARNs is the platform account.
const PLATFORM_ROLE_ARN_ENV_NAMES = [
  "CONVEX_AWS_ROLE_ARN",
  "SANDBOX_MOUNT_ROLE_ARN",
  "MICROVM_EXECUTION_ROLE_ARN",
  "MICROVM_BUILD_ROLE_ARN",
];
const ROLE_ARN_PATTERN = /^arn:[a-z-]+:iam::(\d+):role\/.+$/;
// An account's R2 S3 endpoint, optionally in a jurisdiction; group 1 is the
// Cloudflare account id.
const R2_HOSTNAME_PATTERN =
  /^([a-f0-9]{32})(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/;

/** Per-file cap, enforced on the S3 write path and on dashboard uploads. */
export const MAX_WORKSPACE_FILE_BYTES = 512 * 1024;
export const WORKSPACE_STORAGE_PROVIDERS = ["s3"] as const;

export type WorkspaceStorageProvider =
  (typeof WORKSPACE_STORAGE_PROVIDERS)[number];

export type WorkspaceStorageAuth =
  | { type: "managed" }
  | { type: "assumeRole"; roleArn: string; externalId?: string }
  | {
      type: "r2";
      /** `${NAME}` ref to the parent R2 token's access key id. */
      accessKeyId: string;
      /** `${NAME}` ref to the parent R2 token's secret access key. */
      secretAccessKey: string;
    };

/** The auth that reaches a bucket the workspace names itself. */
export type WorkspaceStorageOwnAuth = Extract<
  WorkspaceStorageAuth,
  { type: "assumeRole" | "r2" }
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
  isolation?: WorkspaceIsolation;
  // Named harness features, each with its own options (no top-level enabled):
  // workspace = the <workspace> prompt, memory = structured memory.
  harness?: {
    workspace?: { enabled?: boolean };
    memory?: { enabled?: boolean };
  };
}

/**
 * A storage endpoint is a public https URL. ALLOW_PRIVATE_STORAGE_ENDPOINTS=true
 * lets a self-host operator also use a private or single-label host, over http
 * or https. A public host stays https only.
 */
export function assertStorageEndpoint(value: string, label: string): void {
  if (
    process.env.ALLOW_PRIVATE_STORAGE_ENDPOINTS === "true" &&
    isClusterEndpoint(value)
  )
    return;
  assertPublicHttpsUrl(value, label);
}

/**
 * A workspace key prefix with no leading slash and one trailing slash, or ""
 * for the bucket root. Shared by the file actions and the R2 credential grant.
 */
export function normalizeWorkspacePrefix(prefix: string | undefined): string {
  const trimmed = (prefix ?? "").replace(/^\/+/, "").replace(/\/+$/, "");

  return trimmed.length > 0 ? `${trimmed}/` : "";
}

/**
 * The Cloudflare account id of an R2 S3 endpoint
 * (`https://<account>.r2.cloudflarestorage.com`), or undefined when the URL is
 * anything else. The R2 credential grant signs it as its subject.
 */
export function r2AccountId(endpoint: string): string | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    return undefined;

  return R2_HOSTNAME_PATTERN.exec(url.hostname)?.[1];
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
    throw new ClientError("config must be an object");
  }

  const config = value;
  const storage = normalizeWorkspaceStorage(config.storage);
  assertOptionalEnum(
    config.isolation,
    "config.isolation",
    WORKSPACE_ISOLATION_LEVELS,
  );
  let harness:
    | { workspace?: { enabled?: boolean }; memory?: { enabled?: boolean } }
    | undefined;
  if (config.harness !== undefined) {
    if (!isPlainObject(config.harness)) {
      throw new ClientError("config.harness must be an object");
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
    ...(config.isolation ? { isolation: config.isolation } : {}),
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
  if (!isPlainObject(value))
    throw new ClientError("Request body must be an object");
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
  if (!isPlainObject(value))
    throw new ClientError("Request body must be an object");

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
 * credentials only ever reach the managed bucket. Run on save and on every
 * resolve, so a stored row that breaks the rule fails closed.
 * @returns the bucket's own auth, or undefined for the managed bucket
 */
export function workspaceStorageOwnAuth(
  storage: WorkspaceStorageConfig,
): WorkspaceStorageOwnAuth | undefined {
  if (storage.endpoint) {
    if (!storage.bucket) {
      throw new ClientError(
        "config.storage.endpoint requires config.storage.bucket; the managed bucket has no custom endpoint",
      );
    }
    assertStorageEndpoint(storage.endpoint, "config.storage.endpoint");
  }
  if (!storage.bucket) {
    if (storage.auth?.type === "r2") {
      throw new ClientError(
        'config.storage.auth.type "r2" requires config.storage.bucket; R2 has no managed bucket',
      );
    }

    return undefined;
  }
  const bucket = storage.bucket.toLowerCase();
  if (
    PLATFORM_BUCKET_ENV_NAMES.some(
      (name) => process.env[name]?.toLowerCase() === bucket,
    )
  ) {
    throw new ClientError(
      "config.storage.bucket must be a bucket you own; omit it to use the managed bucket",
    );
  }
  if (storage.auth?.type === "r2") {
    if (!storage.endpoint || !r2AccountId(storage.endpoint)) {
      throw new ClientError(
        'config.storage.auth.type "r2" requires config.storage.endpoint to be your account R2 endpoint, https://<account id>.r2.cloudflarestorage.com',
      );
    }
    if (storage.region !== undefined && storage.region !== "auto") {
      throw new ClientError(
        'config.storage.region must be "auto" or omitted for R2',
      );
    }

    return storage.auth;
  }
  if (storage.auth?.type !== "assumeRole") {
    throw new ClientError(
      'config.storage.auth.type "assumeRole" or "r2" is required when config.storage.bucket is set; a named bucket is only reached with its own credentials',
    );
  }
  const roleAccountId = ROLE_ARN_PATTERN.exec(storage.auth.roleArn)?.[1];
  if (!roleAccountId) {
    throw new ClientError(
      "config.storage.auth.roleArn must be an IAM role ARN",
    );
  }
  if (
    process.env.AWS_ACCOUNT_ID === roleAccountId ||
    PLATFORM_ROLE_ARN_ENV_NAMES.some((name) =>
      process.env[name]?.includes(`::${roleAccountId}:`),
    )
  ) {
    throw new ClientError(
      "config.storage.auth.roleArn must not be a role in the platform AWS account",
    );
  }

  return storage.auth;
}

/**
 * The env var names a stored workspace's R2 keys reference, empty for any other
 * storage. Reads the stored shape only, so a row a later access rule refuses
 * never blocks an unrelated env var delete.
 */
export function workspaceEnvRefNames(
  config: WorkspaceConfig | undefined,
): string[] {
  const auth = config?.storage?.auth;
  if (auth?.type !== "r2") return [];

  return [auth.accessKeyId, auth.secretAccessKey].flatMap(
    (ref) => ACCOUNT_ENV_REF_PATTERN.exec(ref)?.[1] ?? [],
  );
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
  if (typeof value !== "string") throw new ClientError("path is required");
  const path = value.trim().replace(/^\/+|\/+$/g, "");
  const parts = path.split("/");
  if (
    !path ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  )
    throw new ClientError("Invalid workspace file path");

  return path;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new ClientError("config must be an object");

  return value;
}

function assertOptionalBoolean(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new ClientError(`${name} must be a boolean`);
  }
}

function assertOptionalEnum<T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
): asserts value is T | undefined {
  if (
    value !== undefined &&
    (typeof value !== "string" || !allowed.includes(value as T))
  ) {
    throw new ClientError(`${name} must be one of: ${allowed.join(", ")}`);
  }
}

/** An http(s) URL whose host is private or a single-label service name. */
function isClusterEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  return (
    ["http:", "https:"].includes(url.protocol) &&
    (isPrivateHostname(url.hostname) || !/[.:]/.test(url.hostname))
  );
}

function normalizeHarnessFeature(
  value: unknown,
  name: string,
): { enabled?: boolean } | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw new ClientError(`${name} must be an object`);
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
    throw new ClientError("config.storage must be an object");
  }
  if (value.provider === "vercel") {
    throw new ClientError(
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
    throw new ClientError(
      "config.storage.prefix is required when config.storage.bucket is set; the sandbox mount is scoped to that prefix",
    );
  }
  const auth = normalizeWorkspaceStorageAuth(value.auth);
  // Only R2 keys are resolved; a ref anywhere else would be kept as literal text.
  const literals = {
    "config.storage.bucket": bucket,
    "config.storage.region": region,
    "config.storage.endpoint": endpoint,
    "config.storage.prefix": prefix,
    ...(auth?.type === "assumeRole"
      ? {
          "config.storage.auth.roleArn": auth.roleArn,
          "config.storage.auth.externalId": auth.externalId,
        }
      : {}),
  };
  for (const [name, literal] of Object.entries(literals)) {
    if (literal && ACCOUNT_ENV_PLACEHOLDER_PATTERN.test(literal)) {
      throw new ClientError(
        `${name} cannot be an env reference; only R2 keys take env()`,
      );
    }
  }
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
    throw new ClientError("config.storage.auth must be an object");
  }
  if (value.type === "managed") {
    return { type: "managed" };
  }
  if (value.type === "r2") {
    const accessKeyId = requireString(
      value.accessKeyId,
      "config.storage.auth.accessKeyId",
    );
    const secretAccessKey = requireString(
      value.secretAccessKey,
      "config.storage.auth.secretAccessKey",
    );
    if (
      !ACCOUNT_ENV_REF_PATTERN.test(accessKeyId) ||
      !ACCOUNT_ENV_REF_PATTERN.test(secretAccessKey)
    ) {
      throw new ClientError(
        "config.storage.auth.accessKeyId and secretAccessKey must each be one ${NAME} env reference; workspace config never stores key values",
      );
    }

    return {
      type: "r2",
      accessKeyId: accessKeyId,
      secretAccessKey: secretAccessKey,
    };
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
  throw new ClientError(
    "config.storage.auth.type must be one of: managed, assumeRole, r2",
  );
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new ClientError(`${name} must be a string`);
  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ClientError(`${name} must be a non-empty string`);
  }

  return value.trim();
}
