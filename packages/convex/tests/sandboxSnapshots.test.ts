/// <reference types="vite/client" />

import cronsComponent from "@convex-dev/crons/test";
import workosTest from "@convex-dev/workos-authkit/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, components, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const SECRET_HASH = "hash-sandbox-snapshots";

type T = ReturnType<typeof convexTest>;

type Seeded = {
  accountId: Id<"accounts">;
  otherAccountId: Id<"accounts">;
  dev: { projectId: Id<"projects">; stageId: Id<"stages"> };
  prod: { projectId: Id<"projects">; stageId: Id<"stages"> };
};

beforeEach(() => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function seed(t: T): Promise<Seeded> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: "auth_owner@example.com",
      plan: "free" as const,
      createdAt: now,
    });
    const userId = await ctx.db.insert("users", {
      authId: "auth_owner@example.com",
      email: "owner@example.com",
      name: "Owner",
      plan: "free" as const,
    });
    await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: userId,
      role: "owner" as const,
      createdAt: now,
    });
    const account = {
      orgId: orgId,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    };
    const accountId = await ctx.db.insert("accounts", {
      ...account,
      username: "snapshots",
      secretHash: SECRET_HASH,
    });
    const otherAccountId = await ctx.db.insert("accounts", {
      ...account,
      orgId: await ctx.db.insert("orgs", {
        name: "other",
        slug: "other",
        ownerAuthId: "auth_other@example.com",
        plan: "free" as const,
        createdAt: now,
      }),
      username: "other",
      secretHash: "hash-other",
    });
    const projectId = await ctx.db.insert("projects", {
      authId: "auth_owner@example.com",
      orgId: orgId,
      name: "snap",
      slug: "snap",
      updatedAt: now,
    });
    const stage = async (
      name: string,
      kind: "development" | "production",
    ): Promise<Id<"stages">> =>
      await ctx.db.insert("stages", {
        authId: "auth_owner@example.com",
        projectId: projectId,
        name: name,
        kind: kind,
        isDefault: kind === "development",
        updatedAt: now,
      });

    return {
      accountId: accountId,
      otherAccountId: otherAccountId,
      dev: {
        projectId: projectId,
        stageId: await stage("development", "development"),
      },
      prod: {
        projectId: projectId,
        stageId: await stage("production", "production"),
      },
    };
  });
}

test("a snapshot name another provider holds is refused, not repointed", async () => {
  const t = convexTest(schema, modules);
  const { accountId, dev } = await seed(t);
  const lambdaImage =
    "arn:aws:lambda:us-east-1:123456789012:microvm-image:broods-snapshot-base";
  await t.mutation(internal.sandbox.snapshots.upsert, {
    accountId: accountId,
    scope: dev,
    name: "base",
    provider: "lambda",
    baseImage: "default",
    externalImageId: lambdaImage,
  });

  await expect(
    t.mutation(internal.sandbox.snapshots.upsert, {
      accountId: accountId,
      scope: dev,
      name: "base",
      provider: "daytona",
      baseImage: "daytona",
      externalImageId: "broods-daytona-1",
    }),
  ).rejects.toThrow('snapshot name "base" is already a lambda snapshot');

  const rows = await t.run(async (ctx) =>
    ctx.db.query("sandboxSnapshots").collect(),
  );
  expect(rows.map((row) => [row.provider, row.externalImageId])).toEqual([
    ["lambda", lambdaImage],
  ]);
});

test("a dev capture never repoints the production snapshot of the same name", async () => {
  const t = convexTest(schema, modules);
  const { accountId, dev, prod } = await seed(t);
  for (const [scope, image] of [
    [prod, "img_prod"],
    [dev, "img_dev"],
  ] as const) {
    await t.mutation(internal.sandbox.snapshots.upsert, {
      accountId: accountId,
      scope: scope,
      name: "base",
      provider: "sandbox",
      baseImage: "sandbox",
      externalImageId: image,
    });
  }

  const prodRow = await t.query(internal.sandbox.snapshots.findByImage, {
    accountId: accountId,
    externalImageId: "img_prod",
  });
  expect(prodRow?.scope).toEqual(prod);
  const devRow = await t.query(internal.sandbox.snapshots.findByImage, {
    accountId: accountId,
    externalImageId: "img_dev",
  });
  expect(devRow?.scope).toEqual(dev);
});

test("core sees another account's image as registered, so it never boots it as a provider image", async () => {
  const t = convexTest(schema, modules);
  const { accountId, otherAccountId } = await seed(t);
  await t.mutation(internal.sandbox.snapshots.upsert, {
    accountId: otherAccountId,
    scope: "account",
    name: "theirs",
    provider: "sandbox",
    baseImage: "sandbox",
    externalImageId: "img_theirs",
  });

  const row = await t.query(internal.sandbox.snapshots.findByImage, {
    accountId: accountId,
    externalImageId: "img_theirs",
  });
  expect(row?.accountId).toBe(otherAccountId);
  expect(
    await t.query(internal.sandbox.snapshots.findByImage, {
      accountId: accountId,
      externalImageId: "ubuntu-24.04",
    }),
  ).toBeNull();
});

test("a CLI sync cannot point a stage's sandbox at another stage's snapshot", async () => {
  const t = convexTest(schema, modules);
  const { accountId, prod } = await seed(t);
  await t.mutation(internal.sandbox.snapshots.upsert, {
    accountId: accountId,
    scope: prod,
    name: "prod-disk",
    provider: "sandbox",
    baseImage: "sandbox",
    externalImageId: "img_prod",
  });
  const sync = (stage: string): Promise<unknown> =>
    t.mutation(internal.cli.sync.syncManifestBySecretHash, {
      secretHash: SECRET_HASH,
      manifest: {
        version: 1 as const,
        project: "snap",
        stage: stage,
        resources: [
          {
            kind: "sandbox",
            name: "box",
            config: { provider: "sandbox", snapshot: "img_prod" },
          },
        ],
      },
    });

  await expect(sync("development")).rejects.toThrow(
    "snapshot taken on another stage",
  );
  const devRows = await t.run(async (ctx) =>
    ctx.db.query("sandboxConfigs").collect(),
  );
  expect(devRows).toEqual([]);

  await sync("production");
  const prodRows = await t.run(async (ctx) =>
    ctx.db.query("sandboxConfigs").collect(),
  );
  expect(prodRows.map((row) => row.stageId)).toEqual([prod.stageId]);
});

test("the build watcher leaves a build from before snapshots had a stage alone", async () => {
  const t = convexTest(schema, modules);
  const { accountId, dev } = await seed(t);
  await t.run(async (ctx) => {
    const row = {
      accountId: accountId,
      provider: "lambda" as const,
      baseImage: "default",
      status: "building" as const,
      pulledCount: 0,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    await ctx.db.insert("sandboxSnapshots", {
      ...row,
      name: "old",
      externalImageId: "arn:old",
    });
    await ctx.db.insert("sandboxSnapshots", {
      ...row,
      scope: dev,
      name: "new",
      externalImageId: "arn:new",
    });
  });

  const building = await t.query(
    internal.runtime.listBuildingSandboxSnapshots,
    {},
  );
  expect(building.map((row) => [row.name, row.scope])).toEqual([["new", dev]]);
});

test("a dashboard canvas save cannot point a stage's sandbox at another stage's snapshot", async () => {
  vi.stubEnv("SERVICE_AUTH_SECRET", "test-service-secret");
  const t = convexTest(schema, modules);
  workosTest.register(t);
  cronsComponent.register(t);
  const authId = "user_snapshot_owner";
  const now = new Date().toISOString();
  await t.mutation(components.workOSAuthKit.lib.onWebhookEvent, {
    apiKey: "sk_test_fixture",
    event: {
      id: "evt_snapshot_owner",
      event: "user.created",
      createdAt: now,
      data: {
        id: authId,
        email: "snapshot-owner@example.invalid",
        emailVerified: true,
        metadata: {},
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      authId: authId,
      email: "snapshot-owner@example.invalid",
      name: "Snapshot owner",
      plan: "free",
    });
  });
  const caller = t.withIdentity({ subject: authId });
  const orgId = await caller.mutation(api.org.orgs.create, { name: "snap" });
  const account = await t.mutation(internal.account.accounts.create, {
    orgId: orgId,
    username: "snap",
    secretHash: "hash-canvas-snapshots",
  });
  const { projectId, dev, prod } = await t.run(async (ctx) => {
    const project = await ctx.db.insert("projects", {
      authId: authId,
      orgId: orgId,
      name: "snap",
      slug: "snap",
      updatedAt: Date.now(),
    });
    const stage = async (
      name: string,
      kind: "development" | "production",
    ): Promise<Id<"stages">> =>
      await ctx.db.insert("stages", {
        authId: authId,
        projectId: project,
        name: name,
        kind: kind,
        isDefault: kind === "development",
        updatedAt: Date.now(),
      });

    return {
      projectId: project,
      dev: await stage("development", "development"),
      prod: await stage("production", "production"),
    };
  });
  await t.mutation(internal.sandbox.snapshots.upsert, {
    accountId: account._id,
    scope: { projectId: projectId, stageId: prod },
    name: "prod-disk",
    provider: "sandbox",
    baseImage: "sandbox",
    externalImageId: "img_prod",
  });
  const save = (stageId: Id<"stages">): Promise<unknown> =>
    caller.mutation(api.canvas.saveLayout, {
      projectId: projectId,
      stageId: stageId,
      nodes: [
        {
          id: "sandbox-1",
          type: "sandbox",
          position: { x: 0, y: 0 },
          data: {
            label: "box",
            config: { provider: "sandbox", snapshot: "img_prod" },
          },
        },
      ],
      edges: [],
    });

  await expect(save(dev)).rejects.toThrow("snapshot taken on another stage");
  await save(prod);
  const rows = await t.run(async (ctx) =>
    ctx.db.query("sandboxConfigs").collect(),
  );
  expect(rows.map((row) => row.stageId)).toEqual([prod]);
});
