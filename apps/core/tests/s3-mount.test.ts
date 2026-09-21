import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

let lastAssumeRoleInput: Record<string, unknown> | undefined;
const assumeRoleSendMock = mock(async () => ({
  Credentials: {
    AccessKeyId: "ASIA_TEMP",
    SecretAccessKey: "temp-secret",
    SessionToken: "temp-token",
  },
}));
mock.module("@aws-sdk/client-sts", () => ({
  STSClient: class {
    send = assumeRoleSendMock;
  },
  AssumeRoleCommand: class {
    constructor(input: Record<string, unknown>) {
      lastAssumeRoleInput = input;
    }
  },
}));

const {
  mountRoleArn,
  resolveS3Mount,
  resolveS3MountIdentity,
  resolveS3ReadTarget,
} = await import("../src/harness/sandbox/s3-mount.ts");

const NS = "fs-abc";
const BYO_STORAGE = {
  provider: "s3" as const,
  bucket: "acme-cached",
  prefix: "agents/",
  auth: { type: "assumeRole" as const, roleArn: "arn:aws:iam::3:role/byo" },
};

const RULE_ENV_NAMES = [
  "SANDBOX_MOUNT_ROLE_ARN",
  "FILESYSTEM_BUCKET_NAME",
  "ALLOW_PRIVATE_STORAGE_ENDPOINTS",
];

beforeEach(() => {
  lastAssumeRoleInput = undefined;
  assumeRoleSendMock.mockClear();
  for (const name of RULE_ENV_NAMES) delete process.env[name];
});

afterEach(() => {
  for (const name of RULE_ENV_NAMES) delete process.env[name];
});

describe("resolveS3MountIdentity", () => {
  it("uses the managed bucket + namespace prefix when storage omits a bucket", () => {
    expect(
      resolveS3MountIdentity({
        storage: undefined,
        namespace: NS,
        managedBucket: "managed-bucket",
        region: "us-east-1",
      }),
    ).toEqual({
      bucket: "managed-bucket",
      prefix: `${NS}/`,
      region: "us-east-1",
    });
  });

  it("keeps managed isolated namespaces inside the managed bucket prefix", () => {
    expect(
      resolveS3MountIdentity({
        storage: undefined,
        namespace: `${NS}/support/fs-conversation`,
        managedBucket: "managed-bucket",
      }),
    ).toEqual({
      bucket: "managed-bucket",
      prefix: `${NS}/support/fs-conversation/`,
    });
  });

  it("uses a bring-your-own bucket with its own (normalized) prefix", () => {
    expect(
      resolveS3MountIdentity({
        storage: {
          ...BYO_STORAGE,
          bucket: "acme",
          prefix: "/agents",
          region: "eu-west-1",
          endpoint: "https://r2.example.com",
        },
        namespace: NS,
        managedBucket: "managed-bucket",
      }),
    ).toEqual({
      bucket: "acme",
      prefix: "agents/",
      region: "eu-west-1",
      endpoint: "https://r2.example.com",
    });
  });

  it("refuses a bring-your-own bucket without a prefix instead of mounting the whole bucket", () => {
    expect(() =>
      resolveS3MountIdentity({
        storage: { ...BYO_STORAGE, prefix: undefined },
        namespace: NS,
      }),
    ).toThrow("storage.prefix is required for a bring-your-own bucket");
    expect(() =>
      resolveS3MountIdentity({
        storage: { ...BYO_STORAGE, prefix: "/" },
        namespace: NS,
      }),
    ).toThrow("storage.prefix is required for a bring-your-own bucket");
  });

  it("adds isolation folders under a bring-your-own bucket prefix without changing buckets", () => {
    expect(
      resolveS3MountIdentity({
        storage: { ...BYO_STORAGE, bucket: "acme" },
        namespace: `${NS}/support`,
      }),
    ).toEqual({ bucket: "acme", prefix: "agents/support/" });
  });

  it("refuses a platform bucket, whatever its case", () => {
    process.env.FILESYSTEM_BUCKET_NAME = "Managed-Bucket";
    expect(() =>
      resolveS3MountIdentity({
        storage: { ...BYO_STORAGE, bucket: "managed-BUCKET" },
        namespace: NS,
      }),
    ).toThrow("config.storage.bucket must be a bucket you own");
  });

  it("refuses a role in the platform account", () => {
    process.env.SANDBOX_MOUNT_ROLE_ARN = "arn:aws:iam::3:role/platform";
    expect(() =>
      resolveS3MountIdentity({ storage: BYO_STORAGE, namespace: NS }),
    ).toThrow("roleArn must not be a role in the platform AWS account");
  });

  it("requires public https endpoints unless the operator allows private ones", () => {
    const privateStorage = { ...BYO_STORAGE, endpoint: "http://10.0.0.5:9000" };
    const privateOption = {
      storage: undefined,
      namespace: NS,
      managedBucket: "managed-bucket",
      endpoint: "https://localhost:9000",
    };
    expect(() =>
      resolveS3MountIdentity({ storage: privateStorage, namespace: NS }),
    ).toThrow("config.storage.endpoint must use https");
    expect(() => resolveS3MountIdentity(privateOption)).toThrow(
      "options.s3Endpoint must not point to a private or internal address",
    );
    process.env.ALLOW_PRIVATE_STORAGE_ENDPOINTS = "true";
    expect(
      resolveS3MountIdentity({ storage: privateStorage, namespace: NS })
        .endpoint,
    ).toBe("http://10.0.0.5:9000");
    expect(resolveS3MountIdentity(privateOption).endpoint).toBe(
      "https://localhost:9000",
    );
  });

  it("ignores the sandbox endpoint when the workspace sets its own", () => {
    const identity = resolveS3MountIdentity({
      storage: { ...BYO_STORAGE, endpoint: "https://r2.example.com" },
      namespace: NS,
      endpoint: "http://10.0.0.5:9000",
    });
    expect(identity.endpoint).toBe("https://r2.example.com");
  });

  it("throws when neither storage.bucket nor a managed bucket is available", () => {
    expect(() =>
      resolveS3MountIdentity({ storage: undefined, namespace: NS }),
    ).toThrow("workspace S3 mount requires storage.bucket or a managed bucket");
  });
});

describe("mountRoleArn", () => {
  it("uses the workspace's own role for a bucket it names", () => {
    process.env.SANDBOX_MOUNT_ROLE_ARN = "arn:aws:iam::1:role/platform";
    expect(mountRoleArn(BYO_STORAGE)).toBe("arn:aws:iam::3:role/byo");
  });

  it("never falls back to the platform role for a named bucket", async () => {
    process.env.SANDBOX_MOUNT_ROLE_ARN = "arn:aws:iam::1:role/platform";
    const storage = { provider: "s3" as const, bucket: "acme", prefix: "a/" };
    const expected =
      '"assumeRole" is required when config.storage.bucket is set';
    expect(() => mountRoleArn(storage)).toThrow(expected);
    expect(() =>
      mountRoleArn({ ...storage, auth: { type: "managed" } }),
    ).toThrow(expected);
    await expect(
      resolveS3ReadTarget({ storage: storage, namespace: NS }),
    ).rejects.toThrow(expected);
    expect(assumeRoleSendMock).not.toHaveBeenCalled();
  });

  it("falls back to the platform role for managed storage", () => {
    process.env.SANDBOX_MOUNT_ROLE_ARN = "arn:aws:iam::1:role/platform";
    expect(mountRoleArn({ provider: "s3" })).toBe(
      "arn:aws:iam::1:role/platform",
    );
    expect(mountRoleArn(undefined)).toBe("arn:aws:iam::1:role/platform");
  });

  it("returns undefined with no assume-role and no platform role", () => {
    expect(mountRoleArn({ provider: "s3" })).toBeUndefined();
  });
});

describe("resolveS3Mount", () => {
  it("returns no credentials for managed storage with no platform role", async () => {
    const mount = await resolveS3Mount({
      storage: undefined,
      namespace: NS,
      managedBucket: "managed-bucket",
    });
    expect(mount.credentials).toBeUndefined();
    expect(assumeRoleSendMock).not.toHaveBeenCalled();
  });

  it("assumes the platform role scoped to the namespace prefix for managed storage", async () => {
    process.env.SANDBOX_MOUNT_ROLE_ARN = "arn:aws:iam::1:role/platform";
    const mount = await resolveS3Mount({
      storage: undefined,
      namespace: NS,
      managedBucket: "managed-bucket",
    });
    expect(mount.credentials).toEqual({
      AWS_ACCESS_KEY_ID: "ASIA_TEMP",
      AWS_SECRET_ACCESS_KEY: "temp-secret",
      AWS_SESSION_TOKEN: "temp-token",
    });
    expect(lastAssumeRoleInput?.RoleArn).toBe("arn:aws:iam::1:role/platform");
    expect(lastAssumeRoleInput?.ExternalId).toBeUndefined();
    expect(String(lastAssumeRoleInput?.Policy)).toContain(
      `managed-bucket/${NS}/`,
    );
  });

  it("assumes the developer's role with the ExternalId, scoped to their bucket/prefix", async () => {
    const mount = await resolveS3Mount({
      storage: {
        provider: "s3",
        bucket: "acme",
        prefix: "agents/",
        auth: {
          type: "assumeRole",
          roleArn: "arn:aws:iam::2:role/byo",
          externalId: "ext-9",
        },
      },
      namespace: NS,
    });
    expect(mount.bucket).toBe("acme");
    expect(mount.prefix).toBe("agents/");
    expect(mount.credentials?.AWS_SESSION_TOKEN).toBe("temp-token");
    expect(lastAssumeRoleInput?.RoleArn).toBe("arn:aws:iam::2:role/byo");
    expect(lastAssumeRoleInput?.ExternalId).toBe("ext-9");
    const policy = JSON.parse(String(lastAssumeRoleInput?.Policy)) as {
      Statement: Array<Record<string, unknown>>;
    };
    expect(policy.Statement[0]?.Resource).toEqual([
      "arn:aws:s3:::acme/agents/*",
    ]);
    expect(policy.Statement[1]?.Condition).toEqual({
      StringLike: { "s3:prefix": ["agents/*"] },
    });
  });

  it("never mints credentials for a prefix that is not a directory", async () => {
    const { assumeScopedMountCredentials } =
      await import("../src/harness/sandbox/s3-mount.ts");
    await expect(
      assumeScopedMountCredentials({
        roleArn: "arn:aws:iam::2:role/byo",
        bucket: "acme",
        prefix: "agents",
      }),
    ).rejects.toThrow('prefix must end with "/"');
    expect(assumeRoleSendMock).not.toHaveBeenCalled();
  });
});

describe("resolveS3ReadTarget", () => {
  it("reads the managed bucket directly, with no per-read assume even when a platform role is set", async () => {
    process.env.SANDBOX_MOUNT_ROLE_ARN = "arn:aws:iam::1:role/platform";
    const target = await resolveS3ReadTarget({
      storage: undefined,
      namespace: NS,
      managedBucket: "managed-bucket",
      region: "us-east-1",
    });
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
        auth: {
          type: "assumeRole",
          roleArn: "arn:aws:iam::2:role/byo",
          externalId: "ext-9",
        },
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

  it("reuses an assumed session across reads until it nears expiry", async () => {
    const inAnHour = new Date(Date.now() + 60 * 60 * 1000);
    assumeRoleSendMock.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: "ASIA_TEMP",
        SecretAccessKey: "temp-secret",
        SessionToken: "temp-token",
        Expiration: inAnHour,
      },
    } as never);

    const first = await resolveS3ReadTarget({
      storage: BYO_STORAGE,
      namespace: NS,
    });
    const second = await resolveS3ReadTarget({
      storage: BYO_STORAGE,
      namespace: NS,
    });

    // Same object, so s3.ts also reuses the client it built for it.
    expect(second).toBe(first);
    expect(assumeRoleSendMock).toHaveBeenCalledTimes(1);

    // A different prefix is a different session policy: never shared.
    await resolveS3ReadTarget({
      storage: { ...BYO_STORAGE, prefix: "other/" },
      namespace: NS,
    });
    expect(assumeRoleSendMock).toHaveBeenCalledTimes(2);
  });

  it("assumes again when the cached session is about to expire", async () => {
    const byoStorage = { ...BYO_STORAGE, bucket: "acme-expiring" };
    assumeRoleSendMock.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: "ASIA_TEMP",
        SecretAccessKey: "temp-secret",
        SessionToken: "temp-token",
        Expiration: new Date(Date.now() + 5 * 60 * 1000),
      },
    } as never);

    await resolveS3ReadTarget({ storage: byoStorage, namespace: NS });
    await resolveS3ReadTarget({ storage: byoStorage, namespace: NS });

    expect(assumeRoleSendMock).toHaveBeenCalledTimes(2);
  });
});
