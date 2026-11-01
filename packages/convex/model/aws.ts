// Node runtime only: import from "use node" actions. A bootstrap user's static key assumes
// ConvexAwsRole (CONVEX_AWS_ROLE_ARN, from apps/core/sst.config.ts) for scoped credentials.

import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { S3Client } from "@aws-sdk/client-s3";

interface AssumedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

interface AwsAccess {
  region: string;
  roleArn: string;
  externalId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

// Core's S3Access, but credentials are required: a foreign bucket never sees our own role.
export interface S3Access {
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
  };
  region?: string;
  endpoint?: string;
}

let cached: { credentials: AssumedCredentials; expiresAt: number } | null =
  null;

// A port of core's assumeScopedMountCredentials: never broader than the tenant's mount.
export async function assumeScopedS3Credentials(params: {
  roleArn: string;
  bucket: string;
  prefix: string;
  externalId: string;
}): Promise<S3Access["credentials"]> {
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
      ExternalId: params.externalId,
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

export async function s3Client(access?: S3Access): Promise<S3Client> {
  return new S3Client({
    region: access?.region ?? awsAccess().region,
    credentials: access ? access.credentials : await assumeCredentials(),
    // A non-AWS S3 endpoint rarely resolves virtual-hosted bucket subdomains.
    ...(access?.endpoint
      ? { endpoint: access.endpoint, forcePathStyle: true }
      : {}),
  });
}

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
