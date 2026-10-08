/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

test("a snapshot name another provider holds is refused, not repointed", async () => {
  const t = convexTest(schema, modules);
  const accountId = await t.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: "auth_owner@example.com",
      plan: "free" as const,
      createdAt: now,
    });

    return await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "snapshots",
      secretHash: "hash-sandbox-snapshots",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
  });
  const lambdaImage =
    "arn:aws:lambda:us-east-1:123456789012:microvm-image:broods-snapshot-base";
  await t.mutation(internal.sandbox.snapshots.upsert, {
    accountId: accountId,
    name: "base",
    provider: "lambda",
    baseImage: "default",
    externalImageId: lambdaImage,
  });

  await expect(
    t.mutation(internal.sandbox.snapshots.upsert, {
      accountId: accountId,
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
