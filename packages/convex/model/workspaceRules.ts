// Config holds no secrets (R2 keys are `${NAME}` env refs), so it is stored and returned in
// plaintext. Core runs the same storage access rule, so it needs the same env names.

import { z } from "zod/mini";

import { assertPublicHttpsUrl, isPrivateHostname } from "./agentRules";
import { mergeConfigObjects } from "./configValues";
import {
  ACCOUNT_ENV_PLACEHOLDER_PATTERN,
  ACCOUNT_ENV_REF_PATTERN,
} from "./envRefs";
import { ClientError } from "./clientError";
import {
  nonEmptyString,
  parseInput,
  resourceCreateInput,
  resourceUpdateInput,
} from "./inputSchema";
import { configObject } from "./storedJson";
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
const PLATFORM_ROLE_ARN_ENV_NAMES = [
  "CONVEX_AWS_ROLE_ARN",
  "SANDBOX_MOUNT_ROLE_ARN",
  "MICROVM_EXECUTION_ROLE_ARN",
  "MICROVM_BUILD_ROLE_ARN",
];
const ROLE_ARN_PATTERN = /^arn:[a-z-]+:iam::(\d+):role\/.+$/;
const R2_HOSTNAME_PATTERN =
  /^([a-f0-9]{32})(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/;

export const MAX_WORKSPACE_FILE_BYTES = 512 * 1024;
export const WORKSPACE_STORAGE_PROVIDERS = ["s3", "disk"] as const;

const optionalString = z.optional(z.string());
const HARNESS_FEATURE = z.optional(
  z.looseObject({ enabled: z.optional(z.boolean()) }),
);
const STORAGE_AUTH = z.discriminatedUnion(
  "type",
  [
    z.looseObject({ type: z.literal("managed") }),
    z.looseObject({
      type: z.literal("r2"),
      accessKeyId: nonEmptyString,
      secretAccessKey: nonEmptyString,
    }),
    z
      .looseObject({ type: z.literal("assumeRole"), roleArn: nonEmptyString })
      .check(
        z.superRefine((auth, ctx): void => {
          // Broods assigns it per account: one a customer picked could be replayed elsewhere.
          if (auth.externalId !== undefined)
            ctx.addIssue({
              code: "custom",
              path: ["externalId"],
              message:
                "is no longer accepted: Broods assigns the external id for your account. Remove it from the config (send null in a PATCH) and require the id from GET /v1/account/storage-trust in your role's trust policy",
            });
        }),
      ),
  ],
  {
    error: (issue): string | undefined =>
      issue.code === "invalid_union"
        ? "must be one of: managed, assumeRole, r2"
        : undefined,
  },
);
const WORKSPACE_CONFIG = z.looseObject({
  storage: z.optional(
    z.looseObject({
      provider: z.optional(
        z.enum(WORKSPACE_STORAGE_PROVIDERS, {
          error: (issue): string | undefined =>
            issue.input === "vercel"
              ? '"vercel" is not supported yet; Vercel Drive workspace storage is not wired. Use "s3" or omit config.storage.'
              : undefined,
        }),
      ),
      bucket: optionalString,
      region: optionalString,
      endpoint: optionalString,
      prefix: optionalString,
      auth: z.optional(STORAGE_AUTH),
    }),
  ),
  isolation: z.optional(z.enum(WORKSPACE_ISOLATION_LEVELS)),
  harness: z.optional(
    z.looseObject({ workspace: HARNESS_FEATURE, memory: HARNESS_FEATURE }),
  ),
});

export type WorkspaceStorageProvider =
  (typeof WORKSPACE_STORAGE_PROVIDERS)[number];

export type WorkspaceStorageAuth =
  | { type: "managed" }
  | { type: "assumeRole"; roleArn: string }
  | {
      type: "r2";
      accessKeyId: string;
      secretAccessKey: string;
    };

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
  // workspace = the <workspace> prompt, memory = structured memory; each defaults on.
  harness?: {
    workspace?: { enabled?: boolean };
    memory?: { enabled?: boolean };
  };
}

export function platformAwsAccountId(): string | undefined {
  if (process.env.AWS_ACCOUNT_ID) return process.env.AWS_ACCOUNT_ID;
  for (const name of PLATFORM_ROLE_ARN_ENV_NAMES) {
    const accountId = ROLE_ARN_PATTERN.exec(process.env[name] ?? "")?.[1];
    if (accountId) return accountId;
  }

  return undefined;
}

export function assertStorageEndpoint(value: string, label: string): void {
  if (
    process.env.ALLOW_PRIVATE_STORAGE_ENDPOINTS === "true" &&
    isClusterEndpoint(value)
  )
    return;
  assertPublicHttpsUrl(value, label);
}

export function normalizeWorkspacePrefix(prefix: string | undefined): string {
  const trimmed = (prefix ?? "").replace(/^\/+/, "").replace(/\/+$/, "");

  return trimmed.length > 0 ? `${trimmed}/` : "";
}

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

export function normalizeWorkspaceConfig(value: unknown): WorkspaceConfig {
  if (value == null) {
    return { storage: { provider: "s3" } };
  }
  const config = parseInput(WORKSPACE_CONFIG, value, "config");
  const storage = normalizeWorkspaceStorage(config.storage);
  const workspacePrompt = disabledFeature(config.harness?.workspace);
  const memory = disabledFeature(config.harness?.memory);
  const harness =
    workspacePrompt || memory
      ? {
          ...(workspacePrompt ? { workspace: workspacePrompt } : {}),
          ...(memory ? { memory: memory } : {}),
        }
      : undefined;

  return {
    storage: storage,
    ...(config.isolation ? { isolation: config.isolation } : {}),
    ...(harness ? { harness: harness } : {}),
  };
}

export function normalizeCreateWorkspaceConfigInput(value: unknown): {
  name: string;
  description?: string;
  config: WorkspaceConfig;
} {
  const input = parseInput(resourceCreateInput, value, "");
  const name = input.name.trim();
  const description = input.description?.trim() || undefined;
  const config = normalizeWorkspaceConfig(input.config);

  return {
    name: name,
    ...(description ? { description: description } : {}),
    config: config,
  };
}

export function normalizeUpdateWorkspaceConfigInput(
  existingConfig: WorkspaceConfig,
  value: unknown,
): { name?: string; description?: string | null; config: WorkspaceConfig } {
  const input = parseInput(resourceUpdateInput, value, "");
  const config =
    "config" in input
      ? normalizeWorkspaceConfig(
          mergeConfigObjects(
            existingConfig,
            parseInput(configObject, input.config, "config"),
          ),
        )
      : existingConfig;

  return {
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.description !== undefined
      ? {
          description:
            input.description === null
              ? null
              : input.description.trim() || undefined,
        }
      : {}),
    config: config,
  };
}

// Platform credentials only ever reach the managed bucket: a named bucket brings its own.
// Runs on save and on every resolve, so a stored row that breaks the rule fails closed.
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

// Stored beside the config so an env var delete finds it by index; undefined clears on patch.
export function workspaceEnvRefFields(config: WorkspaceConfig | undefined): {
  r2AccessKeyEnv: string | undefined;
  r2SecretAccessKeyEnv: string | undefined;
} {
  const auth = config?.storage?.auth;
  if (auth?.type !== "r2") {
    return { r2AccessKeyEnv: undefined, r2SecretAccessKeyEnv: undefined };
  }

  return {
    r2AccessKeyEnv: ACCOUNT_ENV_REF_PATTERN.exec(auth.accessKeyId)?.[1],
    r2SecretAccessKeyEnv: ACCOUNT_ENV_REF_PATTERN.exec(
      auth.secretAccessKey,
    )?.[1],
  };
}

// Byte for byte core's normalizeFilesystemNamespace: S3 and reservation keys live under it.
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

// Here, not in workspaceFs, so default-runtime HTTP routes need not bundle the S3 client.
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

function disabledFeature(
  feature: { enabled?: boolean } | undefined,
): { enabled: false } | undefined {
  return feature?.enabled === false ? { enabled: false } : undefined;
}

function normalizeWorkspaceStorage(
  value: z.output<typeof WORKSPACE_CONFIG>["storage"],
): WorkspaceStorageConfig {
  if (value === undefined) {
    return { provider: "s3" };
  }
  if (value.provider === "disk") {
    const extra = ["bucket", "region", "endpoint", "prefix", "auth"].find(
      (key): boolean => value[key] !== undefined,
    );
    if (extra)
      throw new ClientError(
        `config.storage.${extra} does not apply to "disk": its files live on the sandbox's own disk`,
      );

    return { provider: "disk" };
  }
  const [bucket, region, endpoint, prefix] = [
    value.bucket,
    value.region,
    value.endpoint,
    value.prefix,
  ].map((field): string | undefined => field?.trim() || undefined);
  if (bucket && !prefix?.replace(/^\/+|\/+$/g, "")) {
    throw new ClientError(
      "config.storage.prefix is required when config.storage.bucket is set; the sandbox mount is scoped to that prefix",
    );
  }
  const auth = normalizeWorkspaceStorageAuth(value.auth);
  const literals = {
    "config.storage.bucket": bucket,
    "config.storage.region": region,
    "config.storage.endpoint": endpoint,
    "config.storage.prefix": prefix,
    ...(auth?.type === "assumeRole"
      ? { "config.storage.auth.roleArn": auth.roleArn }
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
    provider: value.provider ?? "s3",
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
  value: z.output<typeof STORAGE_AUTH> | undefined,
): WorkspaceStorageAuth | undefined {
  if (value?.type === "r2") {
    const accessKeyId = value.accessKeyId.trim();
    const secretAccessKey = value.secretAccessKey.trim();
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
  if (value?.type === "assumeRole") {
    return { type: "assumeRole", roleArn: value.roleArn.trim() };
  }

  return value ? { type: "managed" } : undefined;
}
