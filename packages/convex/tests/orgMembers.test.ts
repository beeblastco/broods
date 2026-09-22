/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { OrgRole } from "../model/ownership/org";
import schema from "../schema";

const caller = vi.hoisted(() => ({ authId: "auth_admin" }));

vi.mock("../auth", () => ({
  authKit: { getAuthUser: async () => ({ id: caller.authId }) },
}));

const modules = import.meta.glob("../**/*.ts");

const membersTest = (): TestConvex<typeof schema> =>
  convexTest(schema, modules);

type T = ReturnType<typeof membersTest>;

interface SeededOrg {
  orgId: Id<"orgs">;
  adminMembership: Id<"orgMembers">;
  memberMembership: Id<"orgMembers">;
}

describe("owner role changes", () => {
  test("an admin cannot promote themselves to owner", async () => {
    const t = membersTest();
    const org = await seedOrg(t);
    caller.authId = "auth_admin";

    await expect(
      t.mutation(api.org.members.updateRole, {
        membershipId: org.adminMembership,
        role: "owner",
      }),
    ).rejects.toThrow("Only an owner");
  });

  test("an admin cannot add a new owner", async () => {
    const t = membersTest();
    const org = await seedOrg(t);
    await seedUser(t, "auth_new", "new@example.com");
    caller.authId = "auth_admin";

    await expect(
      t.mutation(api.org.members.add, {
        orgId: org.orgId,
        email: "new@example.com",
        role: "owner",
      }),
    ).rejects.toThrow("Only an owner");
  });

  test("an admin can still manage non-owner roles", async () => {
    const t = membersTest();
    const org = await seedOrg(t);
    caller.authId = "auth_admin";

    await t.mutation(api.org.members.updateRole, {
      membershipId: org.memberMembership,
      role: "admin",
    });

    expect(
      (await t.run(async (ctx) => ctx.db.get(org.memberMembership)))?.role,
    ).toBe("admin");
  });

  test("an owner can grant the owner role", async () => {
    const t = membersTest();
    const org = await seedOrg(t);
    caller.authId = "auth_owner";

    await t.mutation(api.org.members.updateRole, {
      membershipId: org.adminMembership,
      role: "owner",
    });

    expect(
      (await t.run(async (ctx) => ctx.db.get(org.adminMembership)))?.role,
    ).toBe("owner");
  });
});

async function seedOrg(t: T): Promise<SeededOrg> {
  const orgId = await t.run(async (ctx) => {
    return await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: "auth_owner",
      plan: "free",
      createdAt: Date.now(),
    });
  });
  await seedMember(t, orgId, "auth_owner", "owner");
  const adminMembership = await seedMember(t, orgId, "auth_admin", "admin");
  const memberMembership = await seedMember(t, orgId, "auth_member", "member");

  return {
    orgId: orgId,
    adminMembership: adminMembership,
    memberMembership: memberMembership,
  };
}

async function seedMember(
  t: T,
  orgId: Id<"orgs">,
  authId: string,
  role: OrgRole,
): Promise<Id<"orgMembers">> {
  const userId = await seedUser(t, authId, `${authId}@example.com`);

  return await t.run(async (ctx) => {
    return await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: userId,
      role: role,
      createdAt: Date.now(),
    });
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
