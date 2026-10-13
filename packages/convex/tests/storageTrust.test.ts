/// <reference types="vite/client" />
/**
 * The Broods-assigned storage external id: minted once per account, distinct
 * across accounts, sent on every AssumeRole of a customer role from the config
 * plane, and shown with a trust policy through `/v1/account/storage-trust`.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { parseAccountRoute } from "../config/routes/accounts";
import { sha256Hex } from "../model/accountSecrets";
import { assumeScopedS3Credentials } from "../model/aws";
import {
  STORAGE_EXTERNAL_ID_PREFIX,
  storageTrust,
} from "../model/storageTrust";
import schema from "../schema";

vi.mock("../model/aws", () => ({
  assumeScopedS3Credentials: vi.fn(async () => ({
    accessKeyId: "AKIA",
    secretAccessKey: "secret",
    sessionToken: "token",
  })),
  s3Client: vi.fn(),
}));
vi.mock("../model/s3", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../model/s3")>()),
  listS3Prefix: vi.fn(async () => []),
}));

const modules = import.meta.glob("../**/*.ts");
const ROLE_ARN = "arn:aws:iam::111122223333:role/broods-mount";

beforeEach(() => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
  vi.stubEnv("SERVICE_AUTH_SECRET", "test-service-secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(assumeScopedS3Credentials).mockClear();
});

type T = ReturnType<typeof convexTest>;

async function seedAccount(t: T, name: string): Promise<Id<"accounts">> {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", {
      name: name,
      slug: name,
      ownerAuthId: `auth_${name}`,
      plan: "free" as const,
      createdAt: Date.now(),
    });

    return await ctx.db.insert("accounts", {
      orgId: orgId,
      username: name,
      secretHash: await sha256Hex(`bask_${name}`),
      status: "active" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

describe("storage external id", () => {
  it("is minted once per account and differs between accounts", async () => {
    const t = convexTest(schema, modules);
    const first = await seedAccount(t, "first");
    const second = await seedAccount(t, "second");

    const id = await t.mutation(internal.account.storageTrust.externalId, {
      accountId: first,
    });
    const again = await t.mutation(internal.account.storageTrust.externalId, {
      accountId: first,
    });
    const other = await t.mutation(internal.account.storageTrust.externalId, {
      accountId: second,
    });

    expect(id.startsWith(STORAGE_EXTERNAL_ID_PREFIX)).toBe(true);
    // AWS allows 2-1224 chars of [\w+=,.@:/-].
    expect(id).toMatch(/^[\w+=,.@:/-]{2,1224}$/);
    expect(id.length).toBeGreaterThan(STORAGE_EXTERNAL_ID_PREFIX.length + 30);
    expect(again).toBe(id);
    expect(other).not.toBe(id);
    expect(
      (await t.run(async (ctx) => await ctx.db.get(first)))?.storageExternalId,
    ).toBe(id);
  });

  it("is sent on the config plane's AssumeRole of a customer role", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t, "files");
    const workspaceId = await t.mutation(internal.workspace.configs.create, {
      accountId: accountId,
      name: "byo",
      config: {
        storage: {
          provider: "s3",
          bucket: "acme",
          prefix: "agents/",
          auth: { type: "assumeRole", roleArn: ROLE_ARN },
        },
      },
    });

    await t.action(internal.aws.workspaceFiles.list, {
      accountId: accountId,
      workspaceId: workspaceId,
      storage: {
        provider: "s3",
        bucket: "acme",
        prefix: "agents/",
        auth: { type: "assumeRole", roleArn: ROLE_ARN },
      },
    });

    const expected = await t.mutation(
      internal.account.storageTrust.externalId,
      { accountId: accountId },
    );
    expect(vi.mocked(assumeScopedS3Credentials)).toHaveBeenCalledWith({
      roleArn: ROLE_ARN,
      bucket: "acme",
      prefix: "agents/",
      externalId: expected,
    });
  });
});

describe("storage trust", () => {
  it("names the platform account and requires the id", () => {
    vi.stubEnv("AWS_ACCOUNT_ID", "999988887777");
    const trust = storageTrust("broods-abc");

    expect(trust.principalArn).toBe("arn:aws:iam::999988887777:root");
    expect(JSON.parse(trust.trustPolicy ?? "")).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { AWS: "arn:aws:iam::999988887777:root" },
          Action: "sts:AssumeRole",
          Condition: { StringEquals: { "sts:ExternalId": "broods-abc" } },
        },
      ],
    });
  });

  it("falls back to a platform role ARN's account", () => {
    vi.stubEnv("AWS_ACCOUNT_ID", "");
    for (const name of [
      "CONVEX_AWS_ROLE_ARN",
      "MICROVM_EXECUTION_ROLE_ARN",
      "MICROVM_BUILD_ROLE_ARN",
    ])
      vi.stubEnv(name, "");
    vi.stubEnv(
      "SANDBOX_MOUNT_ROLE_ARN",
      "arn:aws:iam::444455556666:role/sandbox-s3mount",
    );

    expect(storageTrust("broods-abc").principalArn).toBe(
      "arn:aws:iam::444455556666:root",
    );
  });

  it("has only the id on a stack with no AWS", () => {
    vi.stubEnv("AWS_ACCOUNT_ID", "");
    for (const name of [
      "CONVEX_AWS_ROLE_ARN",
      "SANDBOX_MOUNT_ROLE_ARN",
      "MICROVM_EXECUTION_ROLE_ARN",
      "MICROVM_BUILD_ROLE_ARN",
    ])
      vi.stubEnv(name, "");

    expect(storageTrust("broods-abc")).toEqual({ externalId: "broods-abc" });
  });

  it("is served at GET /v1/account/storage-trust", async () => {
    vi.stubEnv("AWS_ACCOUNT_ID", "999988887777");
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t, "http");
    const headers = { Authorization: "Bearer bask_http" };

    expect(parseAccountRoute("/v1/account/storage-trust")).toEqual({
      kind: "selfStorageTrust",
    });
    const response = await t.fetch("/v1/account/storage-trust", {
      headers: headers,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      storageTrust: ReturnType<typeof storageTrust>;
    };
    const id = await t.mutation(internal.account.storageTrust.externalId, {
      accountId: accountId,
    });
    expect(body.storageTrust).toEqual(storageTrust(id));

    const anonymous = await t.fetch("/v1/account/storage-trust");
    expect(anonymous.status).toBe(401);
  });
});
