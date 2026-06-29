/**
 * Workspace S3 mount resolver tests (sandbox/s3-mount.ts). Covers the mount
 * identity (managed namespace prefix vs bring-your-own bucket prefix) and the
 * credential resolution (assume-role for BYO + platform role; none when no role),
 * driving the real STS AssumeRole call shape with a mocked client.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

let lastAssumeRoleInput: Record<string, unknown> | undefined;
const assumeRoleSendMock = mock(async () => ({
  Credentials: { AccessKeyId: "ASIA_TEMP", SecretAccessKey: "temp-secret", SessionToken: "temp-token" },
}));
mock.module("@aws-sdk/client-sts", () => ({
  STSClient: class { send = assumeRoleSendMock; },
  AssumeRoleCommand: class { constructor(input: Record<string, unknown>) { lastAssumeRoleInput = input; } },
}));

const {
  mountRoleArn,
  resolveS3Mount,
  resolveS3MountIdentity,
  resolveS3ReadTarget,
} = await import("../functions/harness-processing/sandbox/s3-mount.ts");

const NS = "fs-abc";

beforeEach(() => {
  lastAssumeRoleInput = undefined;
  assumeRoleSendMock.mockClear();
  delete process.env.SANDBOX_MOUNT_ROLE_ARN;
});

afterEach(() => {
  delete process.env.SANDBOX_MOUNT_ROLE_ARN;
});

describe("resolveS3MountIdentity", () => {
  it("uses the managed bucket + namespace prefix when storage omits a bucket", () => {
    expect(resolveS3MountIdentity({ storage: undefined, namespace: NS, managedBucket: "managed-bucket", region: "us-east-1" }))
      .toEqual({ bucket: "managed-bucket", prefix: `${NS}/`, region: "us-east-1" });
  });

  it("uses a bring-your-own bucket with its own (normalized) prefix", () => {
    expect(resolveS3MountIdentity({
      storage: { provider: "s3", bucket: "acme", prefix: "/agents", region: "eu-west-1", endpoint: "https://r2.example.com" },
      namespace: NS,
      managedBucket: "managed-bucket",
    })).toEqual({ bucket: "acme", prefix: "agents/", region: "eu-west-1", endpoint: "https://r2.example.com" });
  });

  it("treats an empty BYO prefix as the whole bucket", () => {
    expect(resolveS3MountIdentity({ storage: { provider: "s3", bucket: "acme" }, namespace: NS }))
      .toEqual({ bucket: "acme", prefix: "" });
  });

  it("throws when neither storage.bucket nor a managed bucket is available", () => {
    expect(() => resolveS3MountIdentity({ storage: undefined, namespace: NS }))
      .toThrow("workspace S3 mount requires storage.bucket or a managed bucket");
  });
});

describe("mountRoleArn", () => {
  it("prefers the storage assume-role over the platform role", () => {
    process.env.SANDBOX_MOUNT_ROLE_ARN = "arn:aws:iam::1:role/platform";
    expect(mountRoleArn({ provider: "s3", auth: { type: "assumeRole", roleArn: "arn:aws:iam::2:role/byo" } }))
      .toBe("arn:aws:iam::2:role/byo");
  });

  it("falls back to the platform role for managed storage", () => {
    process.env.SANDBOX_MOUNT_ROLE_ARN = "arn:aws:iam::1:role/platform";
    expect(mountRoleArn({ provider: "s3" })).toBe("arn:aws:iam::1:role/platform");
    expect(mountRoleArn(undefined)).toBe("arn:aws:iam::1:role/platform");
  });

  it("returns undefined with no assume-role and no platform role", () => {
    expect(mountRoleArn({ provider: "s3" })).toBeUndefined();
  });
});

describe("resolveS3Mount", () => {
  it("returns no credentials for managed storage with no platform role", async () => {
    const mount = await resolveS3Mount({ storage: undefined, namespace: NS, managedBucket: "managed-bucket" });
    expect(mount.credentials).toBeUndefined();
    expect(assumeRoleSendMock).not.toHaveBeenCalled();
  });

  it("assumes the platform role scoped to the namespace prefix for managed storage", async () => {
    process.env.SANDBOX_MOUNT_ROLE_ARN = "arn:aws:iam::1:role/platform";
    const mount = await resolveS3Mount({ storage: undefined, namespace: NS, managedBucket: "managed-bucket" });
    expect(mount.credentials).toEqual({
      AWS_ACCESS_KEY_ID: "ASIA_TEMP",
      AWS_SECRET_ACCESS_KEY: "temp-secret",
      AWS_SESSION_TOKEN: "temp-token",
    });
    expect(lastAssumeRoleInput?.RoleArn).toBe("arn:aws:iam::1:role/platform");
    expect(lastAssumeRoleInput?.ExternalId).toBeUndefined();
    expect(String(lastAssumeRoleInput?.Policy)).toContain(`managed-bucket/${NS}/`);
  });

  it("assumes the developer's role with the ExternalId, scoped to their bucket/prefix", async () => {
    const mount = await resolveS3Mount({
      storage: {
        provider: "s3",
        bucket: "acme",
        prefix: "agents/",
        auth: { type: "assumeRole", roleArn: "arn:aws:iam::2:role/byo", externalId: "ext-9" },
      },
      namespace: NS,
    });
    expect(mount.bucket).toBe("acme");
    expect(mount.prefix).toBe("agents/");
    expect(mount.credentials?.AWS_SESSION_TOKEN).toBe("temp-token");
    expect(lastAssumeRoleInput?.RoleArn).toBe("arn:aws:iam::2:role/byo");
    expect(lastAssumeRoleInput?.ExternalId).toBe("ext-9");
    expect(String(lastAssumeRoleInput?.Policy)).toContain("acme/agents/");
  });
});

describe("resolveS3ReadTarget", () => {
  it("reads the managed bucket directly, with no per-read assume even when a platform role is set", async () => {
    process.env.SANDBOX_MOUNT_ROLE_ARN = "arn:aws:iam::1:role/platform";
    const target = await resolveS3ReadTarget({ storage: undefined, namespace: NS, managedBucket: "managed-bucket", region: "us-east-1" });
    expect(target).toEqual({ bucket: "managed-bucket", prefix: `${NS}/` });
    expect(assumeRoleSendMock).not.toHaveBeenCalled();
  });

  it("assumes the developer's role and carries creds/region/endpoint for a bring-your-own bucket", async () => {
    const target = await resolveS3ReadTarget({
      storage: {
        provider: "s3",
        bucket: "acme",
        prefix: "agents/",
        region: "eu-west-1",
        endpoint: "https://r2.example.com",
        auth: { type: "assumeRole", roleArn: "arn:aws:iam::2:role/byo", externalId: "ext-9" },
      },
      namespace: NS,
    });
    expect(target.bucket).toBe("acme");
    expect(target.prefix).toBe("agents/");
    expect(target.access?.credentials).toEqual({
      accessKeyId: "ASIA_TEMP",
      secretAccessKey: "temp-secret",
      sessionToken: "temp-token",
    });
    expect(target.access?.region).toBe("eu-west-1");
    expect(target.access?.endpoint).toBe("https://r2.example.com");
    expect(lastAssumeRoleInput?.RoleArn).toBe("arn:aws:iam::2:role/byo");
    expect(lastAssumeRoleInput?.ExternalId).toBe("ext-9");
  });
});
