/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { purgeOrg } from "./model/cascade";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

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
      // More rows than one deletion batch holds, so the drain must reschedule
      // itself at least once to finish.
      for (let index = 0; index < 150; index += 1) {
        await ctx.db.insert("skills", {
          accountId: accountId,
          name: `skill-${index}`,
          s3Key: `skills/${index}`,
          createdAt: now,
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
      const skills = await ctx.db
        .query("skills")
        .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
        .collect();
      expect(skills).toHaveLength(0);
    });
  } finally {
    vi.useRealTimers();
  }
});
