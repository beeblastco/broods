/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { purgeOrg } from "../model/cascade";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

test("org deletion drains account contents in scheduled batches", async () => {
  vi.useFakeTimers();

  try {
    const t = convexTest(schema, modules);
    const { orgId, accountId, memberId } = await t.run(async (ctx) => {
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
      const userId = await ctx.db.insert("users", {
        authId: "auth_owner",
        email: "owner@example.com",
        name: "Owner",
        plan: "free",
      });
      const memberId = await ctx.db.insert("orgMembers", {
        orgId: orgId,
        userId: userId,
        role: "owner",
        createdAt: now,
      });
      await ctx.db.insert("accountRoles", {
        accountId: accountId,
        roleId: "fp_role_test",
        name: "reader",
        status: "active",
        policy: { version: 1, rules: [] },
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("usageMeters", {
        accountId: accountId,
        month: "2026-09",
        sandboxVcpuSeconds: 1,
        sandboxGbSeconds: 2,
        sandboxSnapshotGb: 0,
        hostedMcpGbSeconds: 0,
        hostedMcpRequests: 0,
        storageGbMonths: 0,
        egressGb: 0,
        updatedAt: now,
      });
      await ctx.db.insert("usageDays", {
        accountId: accountId,
        day: "2026-09-01",
        sandboxVcpuSeconds: 1,
        sandboxGbSeconds: 2,
        sandboxSnapshotGb: 0,
        hostedMcpGbSeconds: 0,
        hostedMcpRequests: 0,
        storageGbMonths: 0,
        egressGb: 0,
        ingressGb: 0,
        updatedAt: now,
      });
      // Account-scoped rows no project purge reaches, more than one deletion
      // batch holds, so the drain must reschedule itself at least once.
      for (let index = 0; index < 150; index += 1) {
        await ctx.db.insert("accountEnvVars", {
          accountId: accountId,
          name: `VAR_${index}`,
          ciphertext: "ct",
          iv: "iv",
          tag: "tag",
          updatedAt: now,
        });
      }

      return { orgId: orgId, accountId: accountId, memberId: memberId };
    });

    await t.run(async (ctx) => {
      await purgeOrg(ctx, orgId);
    });

    // Org-plane rows go inside the purge transaction; account contents drain
    // through scheduled batches afterwards.
    await t.run(async (ctx) => {
      expect(await ctx.db.get(orgId)).toBeNull();
      expect(await ctx.db.get(memberId)).toBeNull();
      expect(await ctx.db.get(accountId)).not.toBeNull();
    });

    await t.finishAllScheduledFunctions(() => vi.runAllTimers());

    await t.run(async (ctx) => {
      expect(await ctx.db.get(accountId)).toBeNull();
      const envVars = await ctx.db
        .query("accountEnvVars")
        .withIndex("by_accountId_and_name", (q) => q.eq("accountId", accountId))
        .collect();
      expect(envVars).toHaveLength(0);
      expect(await ctx.db.query("accountRoles").collect()).toEqual([]);
      expect(await ctx.db.query("usageMeters").collect()).toEqual([]);
      expect(await ctx.db.query("usageDays").collect()).toEqual([]);
    });
  } finally {
    vi.useRealTimers();
  }
});
