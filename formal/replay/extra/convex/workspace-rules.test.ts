import { afterEach, describe, expect, test } from "bun:test";

import { isWorkspaceIsolation } from "../../../../packages/convex/model/workspaceIsolation";
import {
  normalizeCreateWorkspaceConfigInput,
  normalizeFilePath,
  normalizeUpdateWorkspaceConfigInput,
  platformAwsAccountId,
  workspaceEnvRefFields,
  workspaceNamespace,
  type WorkspaceConfig,
} from "../../../../packages/convex/model/workspaceRules";

const ROLE_ENV_NAMES = [
  "AWS_ACCOUNT_ID",
  "CONVEX_AWS_ROLE_ARN",
  "SANDBOX_MOUNT_ROLE_ARN",
  "MICROVM_EXECUTION_ROLE_ARN",
  "MICROVM_BUILD_ROLE_ARN",
];

afterEach((): void => {
  for (const name of ROLE_ENV_NAMES) delete process.env[name];
});

describe("normalizeFilePath", (): void => {
  test.each([
    ["/a/b.txt/", "a/b.txt"],
    ["  x  ", "x"],
  ])("accepts %p", (input: string, expected: string): void => {
    expect(normalizeFilePath(input)).toBe(expected);
  });

  test.each([[""], ["a//b"], ["a/./b"], ["../a"]])(
    "refuses %p",
    (input: string): void => {
      expect((): string => normalizeFilePath(input)).toThrow(
        "Invalid workspace file path",
      );
    },
  );

  test("refuses a non-string", (): void => {
    expect((): string => normalizeFilePath(5)).toThrow("path is required");
  });
});

describe("platformAwsAccountId", (): void => {
  test("prefers AWS_ACCOUNT_ID", (): void => {
    process.env.AWS_ACCOUNT_ID = "111111111111";
    expect(platformAwsAccountId()).toBe("111111111111");
  });

  test("falls back to a role ARN", (): void => {
    process.env.MICROVM_BUILD_ROLE_ARN = "arn:aws:iam::222222222222:role/build";
    expect(platformAwsAccountId()).toBe("222222222222");
  });

  test("is undefined with neither", (): void => {
    expect(platformAwsAccountId()).toBeUndefined();
  });
});

describe("workspaceEnvRefFields", (): void => {
  test("reads both refs from r2 auth", (): void => {
    const config: WorkspaceConfig = {
      storage: {
        provider: "s3",
        auth: {
          type: "r2",
          accessKeyId: "${R2_KEY}",
          secretAccessKey: "${R2_SECRET}",
        },
      },
    };
    expect(workspaceEnvRefFields(config)).toEqual({
      r2AccessKeyEnv: "R2_KEY",
      r2SecretAccessKeyEnv: "R2_SECRET",
    });
  });

  test("is empty without r2 auth", (): void => {
    expect(workspaceEnvRefFields(undefined)).toEqual({
      r2AccessKeyEnv: undefined,
      r2SecretAccessKeyEnv: undefined,
    });
  });
});

describe("workspaceNamespace", (): void => {
  test("is a stable prefixed hash", async (): Promise<void> => {
    const first = await workspaceNamespace("acct", "ws");
    expect(first).toMatch(/^fs-[0-9a-f]{40}$/);
    expect(await workspaceNamespace("acct", "ws")).toBe(first);
    expect(await workspaceNamespace("acct", "other")).not.toBe(first);
  });
});

describe("workspace config input", (): void => {
  const r2Storage = {
    provider: "s3",
    bucket: "my-bucket",
    prefix: "team/",
    endpoint: `https://${"a".repeat(32)}.r2.cloudflarestorage.com`,
  };

  test("create trims the name and drops a blank description", (): void => {
    expect(
      normalizeCreateWorkspaceConfigInput({
        name: " docs ",
        description: "  ",
        config: null,
      }),
    ).toEqual({ name: "docs", config: { storage: { provider: "s3" } } });
  });

  test("create keeps a description", (): void => {
    expect(
      normalizeCreateWorkspaceConfigInput({
        name: "docs",
        description: " d ",
        config: null,
      }).description,
    ).toBe("d");
  });

  test("r2 auth keeps env references", (): void => {
    const auth = { type: "r2", accessKeyId: " ${K} ", secretAccessKey: "${S}" };
    const result = normalizeCreateWorkspaceConfigInput({
      name: "r2",
      config: { storage: { ...r2Storage, auth: auth } },
    });
    expect(result.config.storage.auth).toEqual({
      type: "r2",
      accessKeyId: "${K}",
      secretAccessKey: "${S}",
    });
  });

  test("r2 auth refuses a literal key", (): void => {
    const auth = { type: "r2", accessKeyId: "AKIA", secretAccessKey: "${S}" };
    expect(() =>
      normalizeCreateWorkspaceConfigInput({
        name: "r2",
        config: { storage: { ...r2Storage, auth: auth } },
      }),
    ).toThrow("env reference");
  });

  test("assumeRole trims the role", (): void => {
    const result = normalizeCreateWorkspaceConfigInput({
      name: "role",
      config: {
        storage: {
          provider: "s3",
          bucket: "my-bucket",
          prefix: "team/",
          auth: {
            type: "assumeRole",
            roleArn: " arn:aws:iam::333333333333:role/x ",
          },
        },
      },
    });
    expect(result.config.storage.auth).toEqual({
      type: "assumeRole",
      roleArn: "arn:aws:iam::333333333333:role/x",
    });
  });

  test("update without config keeps the stored one", (): void => {
    const existing: WorkspaceConfig = { storage: { provider: "s3" } };
    expect(
      normalizeUpdateWorkspaceConfigInput(existing, {
        name: " n ",
        description: null,
      }),
    ).toEqual({ name: "n", description: null, config: existing });
  });

  test("update merges a new config", (): void => {
    const existing: WorkspaceConfig = { storage: { provider: "s3" } };
    const result = normalizeUpdateWorkspaceConfigInput(existing, {
      description: " d ",
      config: { isolation: "agent" },
    });
    expect(result.description).toBe("d");
    expect(result.config.isolation).toBe("agent");
  });
});

describe("isWorkspaceIsolation", (): void => {
  test.each([
    ["agent", true],
    ["conversation", true],
    ["team", false],
    [1, false],
  ])("%p is %p", (value: unknown, expected: boolean): void => {
    expect(isWorkspaceIsolation(value)).toBe(expected);
  });
});
