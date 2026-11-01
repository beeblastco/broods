import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import {
  assertStorageEndpoint,
  normalizeWorkspacePrefix,
  workspaceStorageOwnAuth,
} from "@broods/convex/model/workspaceRules";
import type { WorkspaceStorageConfig } from "../../shared/domain/workspace-config.ts";
import { optionalEnv } from "../../shared/env.ts";
import { agentNamespaceFolder } from "../../shared/runtime-keys.ts";
import type { S3Access } from "../../shared/s3.ts";
import type { SandboxControlPlane } from "../../shared/sandbox-sizes.ts";
import { workspaceNamespacePrefix } from "../../shared/sandbox.ts";
import { getStorage } from "../../shared/storage.ts";
import type { SandboxExecutorConfig, SandboxRunRequest } from "./types.ts";
import { configString, shellQuote } from "./utils.ts";

// Past the 300s presign a read target can back, plus clock skew.
const READ_TARGET_REFRESH_MARGIN_MS = 10 * 60 * 1000;
// R2 temporary credentials die with their parent token, so a rotation reaches reads this fast.
const R2_READ_TARGET_REUSE_MS = 60 * 1000;
// mount-s3 reads its credentials from env once, so remount before the 1h session expires.
const MOUNT_MAX_AGE_SECONDS = 45 * 60;
const MOUNT_SESSION_NAME = "fp-sandbox-mount";
// STS caps RoleSessionName and SourceIdentity at 64 characters.
const SESSION_IDENTITY_MAX_LENGTH = 64 - MOUNT_SESSION_NAME.length - 1;
const readTargetCache = new Map<
  string,
  { target: Promise<S3ReadTarget>; staleAt: number }
>();

export interface ResolvedS3Mount extends S3MountIdentity {
  credentials?: S3MountCredentials;
}

export interface S3MountAttribution {
  accountId: string;
  agentId?: string;
}

export interface S3MountContext {
  storage: WorkspaceStorageConfig | undefined;
  namespace: string;
  managedBucket?: string;
  region?: string;
  endpoint?: string;
  attribution?: S3MountAttribution;
}

export interface S3MountCredentials {
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_SESSION_TOKEN: string;
  // Without it, mountpoint-s3 treats the session as non-expiring.
  AWS_CREDENTIAL_EXPIRATION?: string;
}

export interface S3MountIdentity {
  bucket: string;
  prefix: string;
  region?: string;
  endpoint?: string;
}

export interface S3ReadTarget {
  bucket: string;
  prefix: string;
  access?: S3Access;
  // A presigned URL cannot outlive the credentials that signed it, so clamp one to this.
  credentialsExpireAt?: Date;
}

// The prefix ends in "/" so `agents/` never also matches `agents-archive/`.
export async function assumeScopedMountCredentials(params: {
  roleArn: string;
  bucket: string;
  prefix: string;
  externalId?: string;
  attribution?: S3MountAttribution;
}): Promise<S3MountCredentials> {
  if (!params.prefix.endsWith("/")) {
    throw new Error(
      `workspace S3 mount prefix must end with "/", got ${JSON.stringify(params.prefix)}`,
    );
  }
  const objectResource = `arn:aws:s3:::${params.bucket}/${params.prefix}*`;
  const statements: Record<string, unknown>[] = [
    {
      Effect: "Allow",
      Action: [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
      ],
      Resource: [objectResource],
    },
    {
      Effect: "Allow",
      Action: ["s3:ListBucket"],
      Resource: [`arn:aws:s3:::${params.bucket}`],
      Condition: { StringLike: { "s3:prefix": [`${params.prefix}*`] } },
    },
  ];

  const attribution = params.attribution;
  const identity = attribution && sessionIdentity(attribution);
  // Only the platform role's trust policy grants sts:SetSourceIdentity and sts:TagSession.
  const platformRole = params.roleArn === optionalEnv("SANDBOX_MOUNT_ROLE_ARN");
  const result = await new STSClient({}).send(
    new AssumeRoleCommand({
      RoleArn: params.roleArn,
      RoleSessionName: identity
        ? `${MOUNT_SESSION_NAME}-${identity}`
        : MOUNT_SESSION_NAME,
      DurationSeconds: 3600,
      Policy: JSON.stringify({ Version: "2012-10-17", Statement: statements }),
      ...(params.externalId ? { ExternalId: params.externalId } : {}),
      ...(attribution && platformRole
        ? {
            SourceIdentity: identity,
            Tags: [
              { Key: "broods:account", Value: attribution.accountId },
              ...(attribution.agentId
                ? [{ Key: "broods:agent", Value: attribution.agentId }]
                : []),
            ],
          }
        : {}),
    }),
  );
  const credentials = result.Credentials;
  if (
    !credentials?.AccessKeyId ||
    !credentials.SecretAccessKey ||
    !credentials.SessionToken
  ) {
    throw new Error("Failed to assume the workspace S3 mount role");
  }

  return {
    AWS_ACCESS_KEY_ID: credentials.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
    AWS_SESSION_TOKEN: credentials.SessionToken,
    ...(credentials.Expiration
      ? { AWS_CREDENTIAL_EXPIRATION: credentials.Expiration.toISOString() }
      : {}),
  };
}

export function executorS3Context(
  config: SandboxExecutorConfig,
  request: Pick<SandboxRunRequest, "namespace" | "metadata">,
): S3MountContext {
  if (!request.namespace) {
    throw new Error("an AWS S3 workspace mount requires a workspace namespace");
  }
  const options = config.options ?? {};

  return {
    storage: config.storage,
    namespace: request.namespace,
    managedBucket:
      configString(options.workspaceBucketName) ??
      optionalEnv("FILESYSTEM_BUCKET_NAME"),
    region:
      configString(options.awsRegion) ??
      optionalEnv("AWS_REGION") ??
      optionalEnv("AWS_DEFAULT_REGION"),
    endpoint: configString(options.s3Endpoint),
    attribution: mountAttribution(config, request),
  };
}

// Age is on the harness clock, since a Firecracker pause freezes the guest's. The stamp is
// agent-writable, so anything but a plain epoch (dash reads a leading 0 as octal) fails.
export function freshMountScript(mountPath: string, now: number): string {
  return [
    `stamp_file=${shellQuote(`${mountPath}.mounted-at`)};`,
    `stamp=$(cat "$stamp_file" 2>/dev/null || echo 0);`,
    `case "$stamp" in '' | *[!0-9]* | 0?* | ???????????*) stamp=0 ;; esac;`,
    `age=$((${now} - stamp));`,
    `mountpoint -q ${shellQuote(mountPath)} && [ "$age" -ge 0 ] && [ "$age" -lt ${MOUNT_MAX_AGE_SECONDS} ]`,
  ].join("\n");
}

// The agent is named only on its own folder: any other mount's creds serve the next agent too.
export function mountAttribution(
  config: { controlPlane?: Pick<SandboxControlPlane, "accountId"> },
  request: Pick<SandboxRunRequest, "namespace" | "metadata">,
): S3MountAttribution | undefined {
  const accountId = config.controlPlane?.accountId;
  if (!accountId) return undefined;
  const agentId = request.metadata?.agentId;
  const ownFolder =
    agentId !== undefined &&
    request.namespace?.endsWith(`/${agentNamespaceFolder(agentId)}`);

  return { accountId: accountId, agentId: ownFolder ? agentId : undefined };
}

export function mountRoleArn(
  storage: WorkspaceStorageConfig | undefined,
): string | undefined {
  if (!storage?.bucket) return optionalEnv("SANDBOX_MOUNT_ROLE_ARN");
  const auth = workspaceStorageOwnAuth(storage);

  return auth?.type === "assumeRole" ? auth.roleArn : undefined;
}

export async function resolveS3Mount(
  ctx: S3MountContext,
): Promise<ResolvedS3Mount> {
  const identity = resolveS3MountIdentity(ctx);
  if (ctx.storage?.auth?.type === "r2") {
    const owner = ctx.storage.owner;
    if (!owner) throw new Error("R2 workspace storage has no owner");
    const minted = await getStorage().workspaceConfigs.mintR2Credentials(
      owner.accountId,
      owner.workspaceId,
      identity.prefix,
    );

    return {
      ...identity,
      region: "auto",
      credentials: {
        AWS_ACCESS_KEY_ID: minted.accessKeyId,
        AWS_SECRET_ACCESS_KEY: minted.secretAccessKey,
        AWS_SESSION_TOKEN: minted.sessionToken,
        AWS_CREDENTIAL_EXPIRATION: minted.expiration,
      },
    };
  }
  const roleArn = mountRoleArn(ctx.storage);
  const credentials = roleArn
    ? await assumeScopedMountCredentials({
        roleArn: roleArn,
        bucket: identity.bucket,
        prefix: identity.prefix,
        externalId: await mountExternalId(ctx.storage),
        attribution: ctx.attribution,
      })
    : undefined;

  return { ...identity, ...(credentials ? { credentials: credentials } : {}) };
}

export function resolveS3MountIdentity(ctx: S3MountContext): S3MountIdentity {
  const storage = ctx.storage;
  // Every mount and read resolves here, so the storage access rule is enforced here.
  if (storage) workspaceStorageOwnAuth(storage);
  if (!storage?.endpoint && ctx.endpoint) {
    assertStorageEndpoint(ctx.endpoint, "options.s3Endpoint");
  }
  const bucket = storage?.bucket ?? ctx.managedBucket;
  if (!bucket) {
    throw new Error(
      "workspace S3 mount requires storage.bucket or a managed bucket (FILESYSTEM_BUCKET_NAME).",
    );
  }
  if (storage?.bucket && !normalizeWorkspacePrefix(storage.prefix)) {
    throw new Error(
      "workspace storage.prefix is required for a bring-your-own bucket; the mount is scoped to bucket/prefix/",
    );
  }
  const prefix = storage?.bucket
    ? joinPrefix(
        normalizeWorkspacePrefix(storage.prefix),
        namespaceIsolationSuffix(ctx.namespace),
      )
    : `${workspaceNamespacePrefix(ctx.namespace)}/`;
  const region = storage?.region ?? ctx.region;
  const endpoint = storage?.endpoint ?? ctx.endpoint;

  return {
    bucket: bucket,
    prefix: prefix,
    ...(region ? { region: region } : {}),
    ...(endpoint ? { endpoint: endpoint } : {}),
  };
}

export async function resolveS3ReadTarget(
  ctx: S3MountContext,
): Promise<S3ReadTarget> {
  const identity = resolveS3MountIdentity(ctx);
  if (!ctx.storage?.bucket) {
    return { bucket: identity.bucket, prefix: identity.prefix };
  }
  const cacheKey = JSON.stringify([
    ctx.storage.auth,
    ctx.storage.owner,
    identity.bucket,
    identity.prefix,
    identity.region,
    identity.endpoint,
  ]);
  const entry = readTargetCache.get(cacheKey);
  const cached =
    entry && entry.staleAt > Date.now()
      ? await entry.target.catch(() => undefined)
      : undefined;
  if (cached && !nearsExpiry(cached)) {
    return cached;
  }
  const pending = readTargetFromMount(ctx);
  readTargetCache.set(cacheKey, {
    target: pending,
    staleAt:
      ctx.storage.auth?.type === "r2"
        ? Date.now() + R2_READ_TARGET_REUSE_MS
        : Number.POSITIVE_INFINITY,
  });
  pending.catch(() => readTargetCache.delete(cacheKey));

  return pending;
}

export function workspaceReadContext(
  storage: WorkspaceStorageConfig | undefined,
  namespace: string,
): S3MountContext {
  return {
    storage: storage,
    namespace: namespace,
    managedBucket: optionalEnv("FILESYSTEM_BUCKET_NAME"),
    region: optionalEnv("AWS_REGION") ?? optionalEnv("AWS_DEFAULT_REGION"),
  };
}

function joinPrefix(
  prefix: string | undefined,
  suffix: string | undefined,
): string {
  const normalizedPrefix = prefix?.replace(/^\/+|\/+$/g, "");
  const normalizedSuffix = suffix?.replace(/^\/+|\/+$/g, "");
  const joined = [normalizedPrefix, normalizedSuffix].filter(Boolean).join("/");

  return joined ? `${joined}/` : "";
}

// The Broods-assigned external id keeps another account from assuming the same customer role.
async function mountExternalId(
  storage: WorkspaceStorageConfig | undefined,
): Promise<string | undefined> {
  if (!storage || workspaceStorageOwnAuth(storage)?.type !== "assumeRole")
    return undefined;
  const owner = storage.owner;
  if (!owner) throw new Error("assumeRole workspace storage has no owner");

  return await getStorage().workspaceConfigs.storageExternalId(owner.accountId);
}

function namespaceIsolationSuffix(namespace: string): string | undefined {
  const separator = namespace.indexOf("/");

  return separator >= 0 ? namespace.slice(separator + 1) : undefined;
}

function nearsExpiry(target: S3ReadTarget): boolean {
  return (
    target.credentialsExpireAt !== undefined &&
    target.credentialsExpireAt.getTime() - Date.now() <=
      READ_TARGET_REFRESH_MARGIN_MS
  );
}

async function readTargetFromMount(ctx: S3MountContext): Promise<S3ReadTarget> {
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
  const expiration = mount.credentials?.AWS_CREDENTIAL_EXPIRATION;

  return {
    bucket: mount.bucket,
    prefix: mount.prefix,
    access: access,
    ...(expiration ? { credentialsExpireAt: new Date(expiration) } : {}),
  };
}

function sessionIdentity(attribution: S3MountAttribution): string {
  return (attribution.agentId ?? `acct-${attribution.accountId}`)
    .replace(/[^\w+=,.@-]/g, "-")
    .slice(0, SESSION_IDENTITY_MAX_LENGTH);
}
