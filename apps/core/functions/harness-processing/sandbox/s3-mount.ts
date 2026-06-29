/**
 * Workspace S3 mount resolution — shared by the runtime-mount providers (workdir,
 * and later daytona). Turns a workspace's storage config (bucket / region /
 * endpoint / prefix / auth) plus the managed defaults into a concrete mount
 * target with credentials. Three credential sources, in precedence:
 *   - `assumeRole` (bring-your-own bucket): assume the developer's cross-account
 *     role, scoped to their bucket/prefix. Keyless; pair with an ExternalId.
 *   - managed + platform role (SANDBOX_MOUNT_ROLE_ARN): assume the broods role,
 *     scoped to the namespace prefix of the managed bucket.
 *   - managed + no role: no harness-resolved credentials — the provider supplies
 *     them another way (workdir's declarative org secrets / sandbox envVars).
 *
 * Credentials are always short-lived and scoped to the mount's own prefix, so the
 * harness's broad creds never reach a sandbox (any code the agent runs can read
 * the mount env). mount-s3 reads them from the standard env credential chain.
 */

import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { optionalEnv } from "../../_shared/env.ts";
import { workspaceNamespacePrefix } from "../../_shared/sandbox.ts";
import type { S3Access } from "../../_shared/s3.ts";
import type { WorkspaceStorageConfig } from "../../_shared/storage/workspace-config.ts";

export interface S3MountIdentity {
  bucket: string;
  // Key prefix the mount exposes (and the assumed session is scoped to). Empty
  // string means the whole bucket (a bring-your-own bucket with no sub-path).
  prefix: string;
  region?: string;
  endpoint?: string;
}

export interface ResolvedS3Mount extends S3MountIdentity {
  // Present when the harness resolved credentials (assume-role / platform role).
  // Absent => the provider must supply credentials itself (workdir declarative
  // org secrets, or static keys in the sandbox envVars).
  credentials?: S3MountCredentials;
}

export interface S3MountCredentials {
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_SESSION_TOKEN: string;
}

export interface S3MountContext {
  storage: WorkspaceStorageConfig | undefined;
  namespace: string;
  // broods-managed bucket fallback (FILESYSTEM_BUCKET_NAME) when storage omits one.
  managedBucket?: string;
  // region/endpoint fallbacks from the executor options when storage omits them.
  region?: string;
  endpoint?: string;
}

// The mount role for a workspace: the developer's `assumeRole` role, else the
// platform role (SANDBOX_MOUNT_ROLE_ARN). Undefined => no role; the provider
// supplies credentials another way. Sync, so the mount strategy can branch on it.
export function mountRoleArn(storage: WorkspaceStorageConfig | undefined): string | undefined {
  return storage?.auth?.type === "assumeRole"
    ? storage.auth.roleArn
    : optionalEnv("SANDBOX_MOUNT_ROLE_ARN");
}

// Resolve the mount identity (bucket / prefix / region / endpoint) — no STS call.
// A bring-your-own bucket uses its own layout (its prefix, default whole bucket);
// the shared managed bucket is partitioned by namespace.
export function resolveS3MountIdentity(ctx: S3MountContext): S3MountIdentity {
  const storage = ctx.storage;
  const bucket = storage?.bucket ?? ctx.managedBucket;
  if (!bucket) {
    throw new Error("workspace S3 mount requires storage.bucket or a managed bucket (FILESYSTEM_BUCKET_NAME).");
  }
  const prefix = storage?.bucket
    ? normalizePrefix(storage.prefix)
    : `${workspaceNamespacePrefix(ctx.namespace)}/`;
  const region = storage?.region ?? ctx.region;
  const endpoint = storage?.endpoint ?? ctx.endpoint;
  return { bucket, prefix, ...(region ? { region } : {}), ...(endpoint ? { endpoint } : {}) };
}

// Where a harness-side read of a workspace lands: the bucket + key prefix, plus the
// S3 access for a bring-your-own bucket (undefined => default client / managed bucket).
export interface S3ReadTarget {
  bucket: string;
  prefix: string;
  access?: S3Access;
}

// Build the resolver context for a harness-side read of a workspace's storage,
// using the env defaults (managed bucket / region) the harness runs with. The
// bring-your-own endpoint, when set, rides storage.endpoint.
export function workspaceReadContext(storage: WorkspaceStorageConfig | undefined, namespace: string): S3MountContext {
  return {
    storage,
    namespace,
    managedBucket: optionalEnv("FILESYSTEM_BUCKET_NAME"),
    region: optionalEnv("AWS_REGION") ?? optionalEnv("AWS_DEFAULT_REGION"),
  };
}

// Resolve a harness read target. The managed bucket is read directly on the
// harness's own role (no per-read STS) exactly as before; a bring-your-own bucket
// assumes the configured role for short-lived, prefix-scoped cross-account creds.
export async function resolveS3ReadTarget(ctx: S3MountContext): Promise<S3ReadTarget> {
  const identity = resolveS3MountIdentity(ctx);
  if (!ctx.storage?.bucket) {
    return { bucket: identity.bucket, prefix: identity.prefix };
  }
  const mount = await resolveS3Mount(ctx);
  const access: S3Access = {
    ...(mount.credentials
      ? {
        credentials: {
          accessKeyId: mount.credentials.AWS_ACCESS_KEY_ID,
          secretAccessKey: mount.credentials.AWS_SECRET_ACCESS_KEY,
          sessionToken: mount.credentials.AWS_SESSION_TOKEN,
        },
      }
      : {}),
    ...(mount.region ? { region: mount.region } : {}),
    ...(mount.endpoint ? { endpoint: mount.endpoint } : {}),
  };
  return { bucket: mount.bucket, prefix: mount.prefix, access };
}

export async function resolveS3Mount(ctx: S3MountContext): Promise<ResolvedS3Mount> {
  const identity = resolveS3MountIdentity(ctx);
  const roleArn = mountRoleArn(ctx.storage);
  const externalId = ctx.storage?.auth?.type === "assumeRole" ? ctx.storage.auth.externalId : undefined;
  const credentials = roleArn
    ? await assumeScopedMountCredentials({ roleArn, bucket: identity.bucket, prefix: identity.prefix, externalId })
    : undefined;
  return { ...identity, ...(credentials ? { credentials } : {}) };
}

// Assume `roleArn` with a session policy narrowed to `bucket/prefix*` (an empty
// prefix means the whole bucket). The role policy bounds the outer permissions;
// this session policy bounds the blast radius to the mount's own prefix.
export async function assumeScopedMountCredentials(params: {
  roleArn: string;
  bucket: string;
  prefix: string;
  externalId?: string;
}): Promise<S3MountCredentials> {
  const objectResource = `arn:aws:s3:::${params.bucket}/${params.prefix}*`;
  const statements: Record<string, unknown>[] = [
    {
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
      Resource: [objectResource],
    },
    {
      Effect: "Allow",
      Action: ["s3:ListBucket"],
      Resource: [`arn:aws:s3:::${params.bucket}`],
      // Scope the listing to the prefix; an empty prefix lists the whole bucket.
      ...(params.prefix ? { Condition: { StringLike: { "s3:prefix": [`${params.prefix}*`] } } } : {}),
    },
  ];

  const result = await new STSClient({}).send(new AssumeRoleCommand({
    RoleArn: params.roleArn,
    RoleSessionName: "fp-sandbox-mount",
    DurationSeconds: 3600,
    Policy: JSON.stringify({ Version: "2012-10-17", Statement: statements }),
    ...(params.externalId ? { ExternalId: params.externalId } : {}),
  }));
  const credentials = result.Credentials;
  if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
    throw new Error("Failed to assume the workspace S3 mount role");
  }

  return {
    AWS_ACCESS_KEY_ID: credentials.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
    AWS_SESSION_TOKEN: credentials.SessionToken,
  };
}

function normalizePrefix(prefix: string | undefined): string {
  const trimmed = (prefix ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed.length > 0 ? `${trimmed}/` : "";
}
