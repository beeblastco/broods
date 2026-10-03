/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

afterEach(() => {
  vi.useRealTimers();
});

test("workspaceIsolationLevels stores a boolean isolation as the conversation level", async () => {
  vi.useFakeTimers();
  const tt = convexTest(schema, modules);
  const configs = [
    { storage: { provider: "s3" }, isolation: true },
    { storage: { provider: "s3" }, isolation: "agent" },
    { storage: { provider: "s3", bucket: "own", prefix: "agents/" } },
  ];
  const ids = await tt.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
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

    return await Promise.all(
      configs.map((config, index) =>
        ctx.db.insert("workspaceConfigs", {
          accountId: accountId,
          name: `workspace-${index}`,
          config: config,
          createdAt: now,
          updatedAt: now,
        }),
      ),
    );
  });

  const result = await tt.mutation(
    internal.migrations.workspaceIsolationLevels,
    {},
  );
  await tt.finishAllScheduledFunctions(vi.runAllTimers);

  expect(result).toEqual({ patched: 1, isDone: true });
  const stored = await tt.run(async (ctx) =>
    Promise.all(ids.map(async (id) => (await ctx.db.get(id))?.config)),
  );
  expect(stored).toEqual([
    { storage: { provider: "s3" }, isolation: "conversation" },
    { storage: { provider: "s3" }, isolation: "agent" },
    { storage: { provider: "s3", bucket: "own", prefix: "agents/" } },
  ]);
});
