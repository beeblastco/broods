/**
 * AWS access for the Convex config plane (epic #85 phase 9). Convex owns the
 * skills/tool-bundle/workspace S3 objects and account cron schedules directly
 * instead of proxying to core. Node-runtime only — import exclusively from
 * `"use node"` actions.
 *
 * Auth: a minimal bootstrap user's static key (Convex deployment env
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) assumes ConvexAwsRole
 * (CONVEX_AWS_ROLE_ARN, created in apps/core/sst.config.ts) for short-lived,
 * scoped credentials. Credentials are cached in-process until near expiry.
 */

import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { S3Client } from "@aws-sdk/client-s3";
import { SchedulerClient } from "@aws-sdk/client-scheduler";

/**
 * Overrides for reaching a bucket the config plane does not own. Mirrors core's
 * `S3Access` (apps/core `src/shared/s3.ts`) so a bring-your-own-bucket workspace
 * reads the same objects here and in the harness.
 */
export interface S3Access {
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
  };
  region?: string;
  endpoint?: string;
}

/**
 * Resolved AWS access configuration from the Convex deployment environment.
 */
interface AwsAccess {
  region: string;
  roleArn: string;
  externalId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Read and validate the AWS access configuration from the environment.
 * @returns the resolved configuration
 * @throws when any required variable is missing
 */
function awsAccess(): AwsAccess {
  const region = process.env.AWS_REGION;
  const roleArn = process.env.CONVEX_AWS_ROLE_ARN;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!region || !roleArn || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "Convex AWS access requires AWS_REGION, CONVEX_AWS_ROLE_ARN, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY",
    );
  }

  return {
    region: region,
    roleArn: roleArn,
    externalId: process.env.CONVEX_AWS_EXTERNAL_ID ?? "broods-convex",
    accessKeyId: accessKeyId,
    secretAccessKey: secretAccessKey,
  };
}

/**
 * Temporary credentials from assuming ConvexAwsRole.
 */
interface AssumedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

let cached: { credentials: AssumedCredentials; expiresAt: number } | null =
  null;

/**
 * Assume ConvexAwsRole and return short-lived credentials, reusing a cached set
 * until it is within a minute of expiry.
 * @returns temporary AWS credentials scoped to the Convex config plane
 * @throws when STS returns no credentials
 */
async function assumeCredentials(): Promise<AssumedCredentials> {
  if (cached && cached.expiresAt - Date.now() > 60_000) {
    return cached.credentials;
  }

  const access = awsAccess();
  const sts = new STSClient({
    region: access.region,
    credentials: {
      accessKeyId: access.accessKeyId,
      secretAccessKey: access.secretAccessKey,
    },
  });
  const result = await sts.send(
    new AssumeRoleCommand({
      RoleArn: access.roleArn,
      RoleSessionName: "broods-convex",
      ExternalId: access.externalId,
      DurationSeconds: 3600,
    }),
  );
  const credentials = result.Credentials;
  if (
    !credentials?.AccessKeyId ||
    !credentials.SecretAccessKey ||
    !credentials.SessionToken
  ) {
    throw new Error("AssumeRole returned no credentials");
  }

  const resolved: AssumedCredentials = {
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
  };
  cached = {
    credentials: resolved,
    expiresAt: credentials.Expiration
      ? credentials.Expiration.getTime()
      : Date.now() + 3600_000,
  };

  return resolved;
}

/**
 * Build an S3 client authenticated as the Convex config plane, or as the scoped
 * session a bring-your-own bucket supplies.
 * @param access optional credentials/region/endpoint overrides for a foreign bucket
 * @returns an S3 client
 */
export async function s3Client(access?: S3Access): Promise<S3Client> {
  const config = awsAccess();

  return new S3Client({
    region: access?.region ?? config.region,
    credentials: access?.credentials ?? (await assumeCredentials()),
    ...(access?.endpoint ? { endpoint: access.endpoint } : {}),
  });
}

/**
 * Assume a workspace's own storage role with a session policy narrowed to
 * `bucket/prefix*`. A faithful port of core's `assumeScopedMountCredentials`, so
 * the config plane never holds broader access to a tenant bucket than the mount.
 * @param params role to assume, the bucket/prefix to scope to, optional external id
 * @returns short-lived credentials for that bucket prefix
 * @throws when STS returns no credentials
 */
export async function assumeScopedS3Credentials(params: {
  roleArn: string;
  bucket: string;
  prefix: string;
  externalId?: string;
}): Promise<NonNullable<S3Access["credentials"]>> {
  const access = awsAccess();
  const objectResource = `arn:aws:s3:::${params.bucket}/${params.prefix}*`;
  const statements = [
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
      // Scope the listing to the prefix; an empty prefix lists the whole bucket.
      ...(params.prefix
        ? { Condition: { StringLike: { "s3:prefix": [`${params.prefix}*`] } } }
        : {}),
    },
  ];
  const sts = new STSClient({
    region: access.region,
    credentials: await assumeCredentials(),
  });
  const result = await sts.send(
    new AssumeRoleCommand({
      RoleArn: params.roleArn,
      RoleSessionName: "broods-convex-workspace",
      DurationSeconds: 3600,
      Policy: JSON.stringify({ Version: "2012-10-17", Statement: statements }),
      ...(params.externalId ? { ExternalId: params.externalId } : {}),
    }),
  );
  const credentials = result.Credentials;
  if (
    !credentials?.AccessKeyId ||
    !credentials.SecretAccessKey ||
    !credentials.SessionToken
  ) {
    throw new Error("Failed to assume the workspace S3 storage role");
  }

  return {
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
  };
}

/**
 * Build an EventBridge Scheduler client authenticated as the Convex config plane.
 * @returns a Scheduler client with assumed-role credentials
 */
export async function schedulerClient(): Promise<SchedulerClient> {
  const access = awsAccess();

  return new SchedulerClient({
    region: access.region,
    credentials: await assumeCredentials(),
  });
}
