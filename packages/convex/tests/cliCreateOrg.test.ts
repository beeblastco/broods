/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { sha256Hex } from "../model/accountSecrets";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const AUTH_ID = "auth_owner";
const TOKEN = "bcli_create-org";

const orgTest = () => convexTest(schema, modules);

type T = ReturnType<typeof orgTest>;

test("an org made from the CLI has the account key row the dashboard shows for its creator", async () => {
  const t = orgTest();
  const userId = await seed(t);

  const context = await t.mutation(internal.cli.auth.createOnboardingOrg, {
    tokenHash: await sha256Hex(TOKEN),
    name: "Second Org",
  });

  const made = await t.run(async (ctx) => {
    const org = await ctx.db
      .query("orgs")
      .withIndex("by_slug", (q) => q.eq("slug", "second-org"))
      .unique();
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_orgId", (q) => q.eq("orgId", org!._id))
      .unique();
    const user = await ctx.db.get(userId);

    return {
      activeOrg: user?.activeOrgId === org?._id,
      description: account?.description,
      createdBy: account?.secretRotatedBy,
    };
  });
  expect(context).not.toBe(null);
  expect(made).toEqual({
    activeOrg: true,
    description: "Broods org Second Org",
    createdBy: userId,
  });
});

async function seed(t: T): Promise<Id<"users">> {
  const tokenHash = await sha256Hex(TOKEN);

  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {
      authId: AUTH_ID,
      email: "owner@example.com",
      name: "Owner",
      plan: "free",
    });
    const orgId = await ctx.db.insert("orgs", {
      name: "First Org",
      slug: "first-org",
      ownerAuthId: AUTH_ID,
      plan: "free",
      createdAt: now,
    });
    await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: userId,
      role: "owner",
      createdAt: now,
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "first-org",
      secretHash: "hash-first-org",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("cliTokens", {
      tokenHash: tokenHash,
      authId: AUTH_ID,
      orgId: orgId,
      accountId: accountId,
      status: "active",
      createdAt: now,
    });

    return userId;
  });
}
