import { afterEach, describe, expect, test } from "bun:test";

import {
  assertStorageEndpoint,
  normalizeWorkspaceConfig,
  r2AccountId,
  workspaceStorageOwnAuth,
  type WorkspaceStorageConfig,
} from "../../../../packages/convex/model/workspaceRules";

const ACCOUNT = "a".repeat(32);
const R2_ENDPOINT = `https://${ACCOUNT}.r2.cloudflarestorage.com`;
const realAccountId = process.env.AWS_ACCOUNT_ID;
const realPrivate = process.env.ALLOW_PRIVATE_STORAGE_ENDPOINTS;

afterEach((): void => {
  restore("AWS_ACCOUNT_ID", realAccountId);
  restore("ALLOW_PRIVATE_STORAGE_ENDPOINTS", realPrivate);
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("r2AccountId", (): void => {
  test("reads the account from an R2 endpoint", (): void => {
    expect(r2AccountId(R2_ENDPOINT)).toBe(ACCOUNT);
  });

  test("a string that is not a URL has no account", (): void => {
    expect(r2AccountId("not a url")).toBeUndefined();
  });

  test("a port, query or path makes the endpoint invalid", (): void => {
    expect(r2AccountId(`${R2_ENDPOINT}:8443`)).toBeUndefined();
    expect(r2AccountId(`${R2_ENDPOINT}/bucket`)).toBeUndefined();
    expect(r2AccountId(R2_ENDPOINT.replace("https", "http"))).toBeUndefined();
  });
});

describe("assertStorageEndpoint", (): void => {
  test("a private endpoint passes only when the cluster flag is set", (): void => {
    process.env.ALLOW_PRIVATE_STORAGE_ENDPOINTS = "true";
    expect((): void =>
      assertStorageEndpoint("http://minio:9000", "config.storage.endpoint"),
    ).not.toThrow();
  });

  test("an unparsable endpoint is refused with the flag set", (): void => {
    process.env.ALLOW_PRIVATE_STORAGE_ENDPOINTS = "true";
    expect((): void =>
      assertStorageEndpoint("not a url", "config.storage.endpoint"),
    ).toThrow();
  });
});

describe("workspaceStorageOwnAuth", (): void => {
  const role = {
    type: "assumeRole",
    roleArn: "arn:aws:iam::210987654321:role/mount",
  } as const;

  function storage(
    extra: Partial<WorkspaceStorageConfig>,
  ): WorkspaceStorageConfig {
    return { provider: "s3", ...extra };
  }

  test("an endpoint needs a bucket", (): void => {
    expect((): unknown =>
      workspaceStorageOwnAuth(storage({ endpoint: R2_ENDPOINT })),
    ).toThrow("config.storage.endpoint requires config.storage.bucket");
  });

  test("R2 auth needs a bucket", (): void => {
    expect((): unknown =>
      workspaceStorageOwnAuth(
        storage({
          auth: { type: "r2", accessKeyId: "${A}", secretAccessKey: "${B}" },
        }),
      ),
    ).toThrow('"r2" requires config.storage.bucket');
  });

  test("R2 auth needs an R2 endpoint", (): void => {
    expect((): unknown =>
      workspaceStorageOwnAuth(
        storage({
          bucket: "mine",
          endpoint: "https://s3.example.com",
          auth: { type: "r2", accessKeyId: "${A}", secretAccessKey: "${B}" },
        }),
      ),
    ).toThrow("your account R2 endpoint");
  });

  test("a role in the platform AWS account is refused", (): void => {
    process.env.AWS_ACCOUNT_ID = "210987654321";

    expect((): unknown =>
      workspaceStorageOwnAuth(storage({ bucket: "mine", auth: role })),
    ).toThrow("must not be a role in the platform AWS account");
  });

  test("a role outside the platform account is returned", (): void => {
    process.env.AWS_ACCOUNT_ID = "111111111111";

    expect(
      workspaceStorageOwnAuth(storage({ bucket: "mine", auth: role })),
    ).toEqual(role);
  });
});

describe("normalizeWorkspaceConfig storage", (): void => {
  test("disk storage keeps no bucket fields", (): void => {
    expect(
      normalizeWorkspaceConfig({ storage: { provider: "disk" } }).storage,
    ).toEqual({ provider: "disk" });
  });

  test("disk storage refuses a bucket field", (): void => {
    expect((): unknown =>
      normalizeWorkspaceConfig({
        storage: { provider: "disk", bucket: "mine" },
      }),
    ).toThrow('config.storage.bucket does not apply to "disk"');
  });

  test("a bucket needs a prefix", (): void => {
    expect((): unknown =>
      normalizeWorkspaceConfig({
        storage: { provider: "s3", bucket: "mine", prefix: "/" },
      }),
    ).toThrow("config.storage.prefix is required");
  });

  test("a bucket cannot be an env reference", (): void => {
    expect((): unknown =>
      normalizeWorkspaceConfig({
        storage: { provider: "s3", bucket: "${BUCKET}", prefix: "team/" },
      }),
    ).toThrow("config.storage.bucket cannot be an env reference");
  });
});
