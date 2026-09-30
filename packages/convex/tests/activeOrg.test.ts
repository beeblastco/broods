/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const caller = vi.hoisted(() => ({ authId: "auth_victim" }));

vi.mock("../auth", () => ({
  authKit: { getAuthUser: async () => ({ id: caller.authId }) },
}));

const modules = import.meta.glob("../**/*.ts");

const activeOrgTest = (): TestConvex<typeof schema> =>
  convexTest(schema, modules);

type T = ReturnType<typeof activeOrgTest>;

describe("active org", () => {
  test("getOrCreate sets the new org as active", async () => {
    const t = activeOrgTest();
    const userId = await seedUser(t, "auth_victim", "victim@example.com");
    caller.authId = "auth_victim";

    const orgId = await t.mutation(api.org.orgs.getOrCreate, {});

    expect((await t.run(async (ctx) => ctx.db.get(userId)))?.activeOrgId).toBe(
      orgId,
    );
  });

  test("an admin adding a user does not take over their active org", async () => {
    const t = activeOrgTest();
    const victimId = await seedUser(t, "auth_victim", "victim@example.com");
    const ownOrg = await seedOrg(t, "victim", victimId, "auth_victim", 1);
    const attackerId = await seedUser(t, "auth_attacker", "evil@example.com");
    const attackerOrg = await seedOrg(
      t,
      "attacker",
      attackerId,
      "auth_attacker",
      2,
    );
    caller.authId = "auth_attacker";

    await t.mutation(api.org.members.add, {
      orgId: attackerOrg,
      email: "victim@example.com",
      role: "admin",
    });
    caller.authId = "auth_victim";

    expect((await t.query(api.org.orgs.getActive, {}))?._id).toBe(ownOrg);
    expect(await t.mutation(api.org.orgs.getOrCreate, {})).toBe(ownOrg);
  });

  test("setActive and create still switch orgs", async () => {
    const t = activeOrgTest();
    const victimId = await seedUser(t, "auth_victim", "victim@example.com");
    const ownOrg = await seedOrg(t, "victim", victimId, "auth_victim", 1);
    const otherOrg = await seedOrg(t, "other", victimId, "auth_victim", 2);
    caller.authId = "auth_victim";

    await t.mutation(api.org.orgs.setActive, { orgId: otherOrg });
    expect((await t.query(api.org.orgs.getActive, {}))?._id).toBe(otherOrg);

    await t.mutation(api.org.orgs.setActive, { orgId: ownOrg });
    expect((await t.query(api.org.orgs.getActive, {}))?._id).toBe(ownOrg);

    const created = await t.mutation(api.org.orgs.create, { name: "fresh" });
    expect((await t.query(api.org.orgs.getActive, {}))?._id).toBe(created);
  });
});

async function seedOrg(
  t: T,
  slug: string,
  ownerId: Id<"users">,
  ownerAuthId: string,
  createdAt: number,
): Promise<Id<"orgs">> {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", {
      name: slug,
      slug: slug,
      ownerAuthId: ownerAuthId,
      plan: "free",
      createdAt: createdAt,
    });
    await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: ownerId,
      role: "owner",
      createdAt: createdAt,
    });

    return orgId;
  });
}

async function seedUser(
  t: T,
  authId: string,
  email: string,
): Promise<Id<"users">> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("users", {
      authId: authId,
      email: email,
      name: authId,
      plan: "free",
    });
  });
}
