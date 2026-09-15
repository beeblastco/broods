/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

test("a replaced connection's late heartbeat and disconnect leave its successor's row alone", async () => {
  const t = convexTest(schema, modules);
  const { accountId, sandboxConfigId } = await t.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: "auth_owner@example.com",
      plan: "free" as const,
      createdAt: now,
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "machine",
      secretHash: "hash-machine-connections",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
    const sandboxConfigId = await ctx.db.insert("sandboxConfigs", {
      accountId: accountId,
      name: "my-mac",
      createdAt: now,
      updatedAt: now,
    });

    return { accountId: accountId, sandboxConfigId: sandboxConfigId };
  });
  const first = {
    accountId: accountId,
    sandboxConfigId: sandboxConfigId,
    connectionId: "first",
  };
  const second = { ...first, connectionId: "second" };

  await t.mutation(internal.sandbox.machines.connected, {
    ...first,
    computer: false,
    mcp: [],
  });
  await t.mutation(internal.sandbox.machines.connected, {
    ...second,
    hostname: "phicks-mbp",
    platform: "darwin",
    computer: true,
    mcp: ["echo"],
  });
  await t.mutation(internal.sandbox.machines.seen, first);
  await t.mutation(internal.sandbox.machines.disconnected, first);
  const held = await t.run(
    async (ctx) => await ctx.db.query("machineConnections").unique(),
  );

  expect(held).toMatchObject({
    connectionId: "second",
    hostname: "phicks-mbp",
    computer: true,
    mcp: ["echo"],
  });
  expect(held?.disconnectedAt).toBeUndefined();

  await t.mutation(internal.sandbox.machines.disconnected, second);
  const closed = await t.run(
    async (ctx) => await ctx.db.query("machineConnections").unique(),
  );

  expect(closed?.disconnectedAt).toEqual(expect.any(Number));
});
