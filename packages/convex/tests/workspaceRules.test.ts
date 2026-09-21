/**
 * Workspace config validation tests, ported from core's former
 * workspace-config.test.ts when the normalizers moved here.
 */

/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { toPublicWorkspaceConfigResponse } from "../model/responses";
import { normalizeSandboxConfig } from "../model/sandboxRules";
import { listWorkspaceFiles } from "../model/workspaceFs";
import {
  normalizeCreateWorkspaceConfigInput,
  normalizeUpdateWorkspaceConfigInput,
  normalizeWorkspaceConfig,
  type WorkspaceConfig,
} from "../model/workspaceRules";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const OWN_BUCKET = {
  provider: "s3" as const,
  bucket: "acme",
  prefix: "agents/",
  auth: {
    type: "assumeRole" as const,
    roleArn: "arn:aws:iam::111122223333:role/broods-mount",
  },
};

describe("workspace config", () => {
  it("defaults to an s3 workspace when config is empty or null", () => {
    expect(normalizeWorkspaceConfig(undefined)).toEqual({
      storage: { provider: "s3" },
    });
    expect(normalizeWorkspaceConfig({})).toEqual({
      storage: { provider: "s3" },
    });
  });

  it("rejects unsupported storage providers plus non-object storage/harness", () => {
    expect(() =>
      normalizeWorkspaceConfig({ storage: { provider: "vercel" } }),
    ).toThrow('config.storage.provider "vercel" is not supported yet');
    expect(() =>
      normalizeWorkspaceConfig({ storage: { provider: "gcs" } }),
    ).toThrow("config.storage.provider must be one of: s3");
    expect(() => normalizeWorkspaceConfig({ storage: "s3" })).toThrow(
      "config.storage must be an object",
    );
    expect(() => normalizeWorkspaceConfig({ harness: true })).toThrow(
      "config.harness must be an object",
    );
    expect(() =>
      normalizeWorkspaceConfig({ harness: { workspace: "yes" } }),
    ).toThrow("config.harness.workspace must be an object");
    expect(() =>
      normalizeWorkspaceConfig({ harness: { workspace: { enabled: "yes" } } }),
    ).toThrow("config.harness.workspace.enabled must be a boolean");
  });

  it("keeps harness feature toggles when present and drops unknown fields", () => {
    expect(
      normalizeWorkspaceConfig({
        storage: { provider: "s3" },
        harness: { workspace: { enabled: false } },
        extra: "x",
      }),
    ).toEqual({
      storage: { provider: "s3" },
      harness: { workspace: { enabled: false } },
    });
    // The legacy top-level harness.enabled flag is gone; unknown harness keys drop.
    expect(
      normalizeWorkspaceConfig({
        storage: { provider: "s3" },
        harness: { enabled: true },
      }),
    ).toEqual({ storage: { provider: "s3" } });
  });

  it("normalizes the harness memory toggle and validates its shape", () => {
    expect(
      normalizeWorkspaceConfig({
        storage: { provider: "s3" },
        harness: { memory: { enabled: false } },
      }),
    ).toEqual({
      storage: { provider: "s3" },
      harness: { memory: { enabled: false } },
    });
    // Features default to on, so a redundant `enabled: true` (or an empty
    // feature object) normalizes away to the omitted form.
    expect(
      normalizeWorkspaceConfig({
        storage: { provider: "s3" },
        harness: { workspace: { enabled: true }, memory: {} },
      }),
    ).toEqual({ storage: { provider: "s3" } });
    expect(() =>
      normalizeWorkspaceConfig({ harness: { memory: true } }),
    ).toThrow("config.harness.memory must be an object");
    expect(() =>
      normalizeWorkspaceConfig({ harness: { memory: { enabled: "yes" } } }),
    ).toThrow("config.harness.memory.enabled must be a boolean");
  });

  it("accepts boolean workspace isolation and rejects old string modes", () => {
    expect(
      normalizeWorkspaceConfig({
        storage: { provider: "s3" },
        isolation: true,
      }),
    ).toEqual({ storage: { provider: "s3" }, isolation: true });
    expect(
      normalizeWorkspaceConfig({
        storage: { provider: "s3" },
        isolation: false,
      }),
    ).toEqual({ storage: { provider: "s3" } });
    expect(() => normalizeWorkspaceConfig({ isolation: "channel" })).toThrow(
      "config.isolation must be a boolean",
    );
  });

  it("parses a bring-your-own bucket with assume-role auth", () => {
    expect(
      normalizeWorkspaceConfig({
        storage: {
          provider: "s3",
          bucket: "acme-workspaces",
          region: "us-west-2",
          endpoint: "https://s3.us-west-2.amazonaws.com",
          prefix: "agents/",
          auth: {
            type: "assumeRole",
            roleArn: "arn:aws:iam::111122223333:role/broods-mount",
            externalId: "ext-1",
          },
        },
      }),
    ).toEqual({
      storage: {
        provider: "s3",
        bucket: "acme-workspaces",
        region: "us-west-2",
        endpoint: "https://s3.us-west-2.amazonaws.com",
        prefix: "agents/",
        auth: {
          type: "assumeRole",
          roleArn: "arn:aws:iam::111122223333:role/broods-mount",
          externalId: "ext-1",
        },
      },
    });
  });

  it("accepts managed auth and an assume-role without externalId", () => {
    expect(
      normalizeWorkspaceConfig({
        storage: { provider: "s3", auth: { type: "managed" } },
      }),
    ).toEqual({ storage: { provider: "s3", auth: { type: "managed" } } });
    expect(
      normalizeWorkspaceConfig({
        storage: {
          provider: "s3",
          bucket: "b",
          prefix: "p",
          auth: { type: "assumeRole", roleArn: "arn:aws:iam::1:role/r" },
        },
      }),
    ).toEqual({
      storage: {
        provider: "s3",
        bucket: "b",
        prefix: "p",
        auth: { type: "assumeRole", roleArn: "arn:aws:iam::1:role/r" },
      },
    });
  });

  it("rejects malformed storage auth and fields", () => {
    expect(() =>
      normalizeWorkspaceConfig({
        storage: { provider: "s3", auth: { type: "assumeRole" } },
      }),
    ).toThrow("config.storage.auth.roleArn must be a non-empty string");
    expect(() =>
      normalizeWorkspaceConfig({
        storage: { provider: "s3", auth: { type: "keys" } },
      }),
    ).toThrow("config.storage.auth.type must be one of: managed, assumeRole");
    expect(() =>
      normalizeWorkspaceConfig({
        storage: { provider: "s3", auth: "managed" },
      }),
    ).toThrow("config.storage.auth must be an object");
    expect(() =>
      normalizeWorkspaceConfig({ storage: { provider: "s3", bucket: 5 } }),
    ).toThrow("config.storage.bucket must be a string");
  });

  it("trims name/description through create input", () => {
    expect(
      normalizeCreateWorkspaceConfigInput({
        name: "  notes  ",
        description: "  shared notes  ",
        config: { harness: { workspace: { enabled: false } } },
      }),
    ).toEqual({
      name: "notes",
      description: "shared notes",
      config: {
        storage: { provider: "s3" },
        harness: { workspace: { enabled: false } },
      },
    });
  });

  it("merges a config patch on update and clears description with null", () => {
    const existing: WorkspaceConfig = {
      storage: { provider: "s3" },
      harness: { workspace: { enabled: false } },
    };
    const patched = normalizeUpdateWorkspaceConfigInput(existing, {
      name: "renamed",
      description: null,
      config: { harness: { workspace: { enabled: true } } },
    });
    // Re-enabling a feature restores the default form: the opt-out is removed
    // rather than replaced with a stored `enabled: true`.
    expect(patched).toEqual({
      name: "renamed",
      description: null,
      config: { storage: { provider: "s3" } },
    });
  });

  it("keeps the existing config when no config patch is supplied", () => {
    const existing: WorkspaceConfig = {
      storage: { provider: "s3" },
      harness: { memory: { enabled: false } },
    };
    expect(
      normalizeUpdateWorkspaceConfigInput(existing, { name: "renamed" }),
    ).toEqual({ name: "renamed", config: existing });
  });

  it("projects the config unredacted with ISO timestamps (no secrets)", () => {
    const doc = {
      _id: "ws_1",
      _creationTime: 0,
      accountId: "acct_1",
      name: "notes",
      config: { storage: { provider: "s3" } },
      createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
      updatedAt: Date.parse("2026-01-01T00:00:00.000Z"),
    } as unknown as Doc<"workspaceConfigs">;
    expect(toPublicWorkspaceConfigResponse(doc)).toEqual({
      accountId: "acct_1",
      workspaceId: "ws_1",
      name: "notes",
      config: { storage: { provider: "s3" } },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });
});

describe("workspace storage prefix", () => {
  it("requires a prefix for a bring-your-own bucket", () => {
    expect(() =>
      normalizeWorkspaceConfig({ storage: { provider: "s3", bucket: "acme" } }),
    ).toThrow(
      "config.storage.prefix is required when config.storage.bucket is set",
    );
    expect(() =>
      normalizeWorkspaceConfig({
        storage: { provider: "s3", bucket: "acme", prefix: "/" },
      }),
    ).toThrow(
      "config.storage.prefix is required when config.storage.bucket is set",
    );
    expect(
      normalizeWorkspaceConfig({
        storage: { ...OWN_BUCKET, prefix: "agents" },
      }).storage,
    ).toEqual({ ...OWN_BUCKET, prefix: "agents" });
  });
});

describe("workspace storage access", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires a named bucket to bring its own auth", () => {
    expect(() =>
      normalizeWorkspaceConfig({
        storage: { provider: "s3", bucket: "acme", prefix: "agents" },
      }),
    ).toThrow('"assumeRole" is required when config.storage.bucket is set');
    expect(() =>
      normalizeWorkspaceConfig({
        storage: { ...OWN_BUCKET, auth: { type: "managed" } },
      }),
    ).toThrow('"assumeRole" is required when config.storage.bucket is set');
  });

  it("refuses a platform bucket, whatever its case", () => {
    vi.stubEnv("SKILLS_BUCKET_NAME", "Platform-Skills");
    expect(() =>
      normalizeWorkspaceConfig({
        storage: { ...OWN_BUCKET, bucket: "platform-SKILLS" },
      }),
    ).toThrow("config.storage.bucket must be a bucket you own");
  });

  it("refuses a role in the platform account", () => {
    vi.stubEnv("CONVEX_AWS_ROLE_ARN", "arn:aws:iam::999900001111:role/convex");
    expect(() =>
      normalizeWorkspaceConfig({
        storage: {
          ...OWN_BUCKET,
          auth: {
            type: "assumeRole",
            roleArn: "arn:aws:iam::999900001111:role/anything",
          },
        },
      }),
    ).toThrow("roleArn must be a role in your own AWS account");
    expect(() =>
      normalizeWorkspaceConfig({
        storage: {
          ...OWN_BUCKET,
          auth: { type: "assumeRole", roleArn: "not-an-arn" },
        },
      }),
    ).toThrow("roleArn must be an IAM role ARN");
  });

  it("requires a public https endpoint unless the operator allows private ones", () => {
    const storage = { ...OWN_BUCKET, endpoint: "http://10.0.0.5:9000" };
    expect(() => normalizeWorkspaceConfig({ storage: storage })).toThrow(
      "config.storage.endpoint must use https",
    );
    expect(() =>
      normalizeWorkspaceConfig({
        storage: { ...OWN_BUCKET, endpoint: "https://169.254.169.254" },
      }),
    ).toThrow("must not point to a private or internal address");
    expect(() =>
      normalizeWorkspaceConfig({
        storage: { provider: "s3", endpoint: "https://r2.example.com" },
      }),
    ).toThrow("config.storage.endpoint requires config.storage.bucket");
    vi.stubEnv("ALLOW_PRIVATE_STORAGE_ENDPOINTS", "true");
    expect(normalizeWorkspaceConfig({ storage: storage }).storage).toEqual(
      storage,
    );
  });

  it("refuses a stored row that names a bucket without its own auth at resolve time", async () => {
    await expect(
      listWorkspaceFiles({
        accountId: "acct_1",
        workspaceId: "ws_1",
        storage: { provider: "s3", bucket: "acme", prefix: "agents/" },
      }),
    ).rejects.toThrow(
      '"assumeRole" is required when config.storage.bucket is set',
    );
  });

  it("lists the stored rows the rules refuse", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const refusedId = await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("orgs", {
        name: "Beeblast",
        slug: "beeblast",
        ownerAuthId: "auth_owner",
        plan: "free",
        createdAt: now,
      });
      const accountId = await ctx.db.insert("accounts", {
        orgId: orgId,
        username: "beeblast",
        secretHash: "hash",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const row = {
        accountId: accountId,
        createdAt: now,
        updatedAt: now,
      };
      await ctx.db.insert("workspaceConfigs", {
        ...row,
        name: "managed",
        config: { storage: { provider: "s3" } },
      });
      await ctx.db.insert("workspaceConfigs", {
        ...row,
        name: "own",
        config: { storage: OWN_BUCKET },
      });

      return await ctx.db.insert("workspaceConfigs", {
        ...row,
        name: "refused",
        config: { storage: { provider: "s3", bucket: "acme", prefix: "a/" } },
      });
    });

    const result = await t.query(
      internal.workspace.configs.listStorageRuleViolations,
      { paginationOpts: { numItems: 10, cursor: null } },
    );
    expect(result.isDone).toBe(true);
    expect(result.violations).toEqual([
      expect.objectContaining({
        workspaceId: refusedId,
        name: "refused",
        bucket: "acme",
      }),
    ]);
  });

  it("applies the same endpoint rule to the sandbox s3Endpoint option", () => {
    expect(() =>
      normalizeSandboxConfig({
        provider: "daytona",
        options: { s3Endpoint: "https://localhost:9000" },
      }),
    ).toThrow(
      "config.options.s3Endpoint must not point to a private or internal address",
    );
  });
});
