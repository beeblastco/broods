/// <reference types="vite/client" />
/**
 * Deleting a canvas card deletes the dashboard row behind it, except a sandbox
 * config that still holds a reserved instance: dropping it would leave the
 * instance's `sandboxConfigId` naming nothing.
 */

import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { pruneOrphanedDashboardRows } from "../canvas";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

test("keeps an unreferenced sandbox config while an instance holds it", async () => {
  const t = convexTest(schema, modules);
  const remaining = await t.run(
    async (ctx): Promise<{ kept: string[]; afterRelease: string[] }> => {
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
        username: "beeblast-dev",
        secretHash: "hash",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const projectId = await ctx.db.insert("projects", {
        authId: "auth_owner",
        orgId: orgId,
        name: "Prune",
        slug: "prune",
        updatedAt: now,
      });
      const stageId = await ctx.db.insert("stages", {
        authId: "auth_owner",
        projectId: projectId,
        name: "development",
        kind: "development",
        isDefault: true,
        updatedAt: now,
      });
      const scope = {
        accountId: accountId,
        projectId: projectId,
        stageId: stageId,
        managedBy: "dashboard" as const,
        createdAt: now,
        updatedAt: now,
      };
      const reservedId = await ctx.db.insert("sandboxConfigs", {
        ...scope,
        name: "reserved",
      });
      await ctx.db.insert("sandboxConfigs", { ...scope, name: "idle" });
      await ctx.db.insert("workspaceConfigs", {
        ...scope,
        name: "ws",
        config: {},
      });
      await ctx.db.insert("sandboxInstances", {
        accountId: accountId,
        projectId: projectId,
        stageId: stageId,
        provider: "lambda",
        reservationKey: "reserved-key",
        sandboxConfigId: reservedId,
        externalId: "microvm-1",
        name: "reserved",
        status: "running",
        specs: { vcpu: 1, memoryMb: 1024, storageGb: 1 },
        createdAt: now,
        lastUsedAt: now,
      });
      const account = await ctx.db.get(accountId);

      await pruneOrphanedDashboardRows(ctx, account, stageId, []);
      const kept = await names();
      // Once the sweeper releases the instance, the next prune drops the config.
      for (const row of await ctx.db.query("sandboxInstances").collect()) {
        await ctx.db.delete(row._id);
      }
      await pruneOrphanedDashboardRows(ctx, account, stageId, []);

      return { kept: kept, afterRelease: await names() };

      async function names(): Promise<string[]> {
        const sandboxes = await ctx.db.query("sandboxConfigs").collect();
        const workspaces = await ctx.db.query("workspaceConfigs").collect();

        return [...sandboxes, ...workspaces].map((row): string => row.name);
      }
    },
  );

  expect(remaining).toEqual({ kept: ["reserved"], afterRelease: [] });
});
