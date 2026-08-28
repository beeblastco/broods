/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const t = () => convexTest(schema, modules);
type T = ReturnType<typeof t>;

/** One account with one active record and one soft-deleted tombstone. */
async function seed(tt: T): Promise<Id<"accounts">> {
  return await tt.run(async (ctx) => {
    const now = Date.now();
    const accountId = await ctx.db.insert("accounts", {
      orgId: "org-placeholder",
      username: "channel-records-test",
      secretHash: "hash",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("channelRecords", {
      accountId: accountId,
      platform: "slack",
      externalId: "C001",
      name: "support",
      config: {},
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("channelRecords", {
      accountId: accountId,
      platform: "slack",
      externalId: "C002",
      name: "retired",
      config: {},
      status: "deleted",
      deletedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    return accountId;
  });
}

test("listActive returns only active records", async () => {
  const tt = t();
  const accountId = await seed(tt);

  const active = await tt.query(internal.channel.records.listActive, {
    accountId: accountId,
  });
  expect(active.map((record) => record.name)).toEqual(["support"]);
});

test("list keeps returning tombstones for account-deletion cleanup", async () => {
  const tt = t();
  const accountId = await seed(tt);

  const all = await tt.query(internal.channel.records.list, {
    accountId: accountId,
  });
  expect(all.map((record) => record.name).sort()).toEqual([
    "retired",
    "support",
  ]);
});
