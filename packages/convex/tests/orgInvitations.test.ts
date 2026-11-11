/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { clientErrorData } from "../model/clientError";
import type { OrgRole } from "../model/ownership/org";
import schema from "../schema";

const caller = vi.hoisted(() => ({ authId: "auth_admin" }));

vi.mock("../auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth")>()),
  authKit: { getAuthUser: async () => ({ id: caller.authId }) },
}));

const modules = import.meta.glob("../**/*.ts");

const invitationsTest = (): TestConvex<typeof schema> =>
  convexTest(schema, modules);

type T = ReturnType<typeof invitationsTest>;

describe("invitations", () => {
  test("an invited person is not a member until they accept", async () => {
    const t = invitationsTest();
    const { orgA } = await seed(t);

    const invitationId = await invite(t, orgA, "auth_guest@example.com");
    expect(await memberIds(t, orgA)).not.toContain("auth_guest");
    caller.authId = "auth_guest";
    expect(await t.query(api.dashboardReads.orgs, {})).toEqual([]);
    expect(await refusal(t.query(api.org.members.list, { orgId: orgA }))).toBe(
      "forbidden",
    );
    expect(await t.query(api.org.invitations.listMine, {})).toMatchObject([
      { orgId: orgA, orgName: "Org A", role: "admin" },
    ]);
    expect((await t.query(api.user.getCurrent, {}))?.invited).toBe(true);

    await t.mutation(api.org.invitations.accept, {
      invitationId: invitationId,
    });

    expect(await memberIds(t, orgA)).toContain("auth_guest");
    expect(await t.query(api.org.invitations.listMine, {})).toEqual([]);
    expect((await t.query(api.user.getCurrent, {}))?.invited).toBeUndefined();
  });

  test("a pending admin invitation does not break the invitee's MCP sign-in", async () => {
    const t = invitationsTest();
    const { orgA, orgB } = await seed(t);
    const accountB = await t.run(async (ctx) =>
      ctx.db.insert("accounts", {
        orgId: orgB,
        username: "org-b",
        secretHash: "hash-org-b",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      }),
    );

    await invite(t, orgA, "auth_other@example.com");
    const login = await t.query(internal.cli.auth.resolveUserLogin, {
      authId: "auth_other",
    });

    expect("account" in login && login.account._id).toBe(accountB);
  });

  test("accepting twice, or after a revoke, finds no invitation", async () => {
    const t = invitationsTest();
    const { orgA } = await seed(t);
    const accepted = await invite(t, orgA, "auth_guest@example.com");
    const revoked = await invite(t, orgA, "auth_other@example.com");
    await t.mutation(api.org.invitations.revoke, { invitationId: revoked });

    caller.authId = "auth_guest";
    await t.mutation(api.org.invitations.accept, { invitationId: accepted });
    expect(
      await refusal(
        t.mutation(api.org.invitations.accept, { invitationId: accepted }),
      ),
    ).toBe("not_found");
    caller.authId = "auth_other";
    expect(
      await refusal(
        t.mutation(api.org.invitations.accept, { invitationId: revoked }),
      ),
    ).toBe("not_found");
  });

  test("only the invited person answers, and only members:write revokes", async () => {
    const t = invitationsTest();
    const { orgA } = await seed(t);
    const invitationId = await invite(t, orgA, "auth_guest@example.com");

    for (const authId of ["auth_admin", "auth_member"]) {
      caller.authId = authId;
      for (const answer of [
        api.org.invitations.accept,
        api.org.invitations.decline,
      ]) {
        expect(
          await refusal(t.mutation(answer, { invitationId: invitationId })),
        ).toBe("not_found");
      }
    }
    expect(
      await refusal(
        t.mutation(api.org.invitations.revoke, { invitationId: invitationId }),
      ),
    ).toBe("unauthorized");
    caller.authId = "auth_guest";
    await t.mutation(api.org.invitations.decline, {
      invitationId: invitationId,
    });

    expect(await t.query(api.org.invitations.listMine, {})).toEqual([]);
    expect(await memberIds(t, orgA)).not.toContain("auth_guest");
  });

  test("a member, the caller, or an email already invited gets no second invitation", async () => {
    const t = invitationsTest();
    const { orgA, orgB } = await seed(t);
    await invite(t, orgA, "auth_guest@example.com");

    for (const email of [
      "auth_member@example.com",
      "auth_admin@example.com",
      " AUTH_GUEST@example.com",
    ]) {
      expect(await refusal(invite(t, orgA, email))).toBe("conflict");
    }
    caller.authId = "auth_other";
    await invite(t, orgB, "auth_guest@example.com");
    caller.authId = "auth_guest";
    expect(
      (await t.query(api.org.invitations.listMine, {})).map(
        (row) => row.orgName,
      ),
    ).toEqual(["Org A", "Org B"]);
  });

  test("an invitation whose org was deleted is gone", async () => {
    const t = invitationsTest();
    const { orgA } = await seed(t);
    const invitationId = await invite(t, orgA, "auth_guest@example.com");
    caller.authId = "auth_owner";
    await t.mutation(api.org.orgs.remove, { orgId: orgA });

    caller.authId = "auth_guest";
    expect(await t.query(api.org.invitations.listMine, {})).toEqual([]);
    expect(
      await refusal(
        t.mutation(api.org.invitations.accept, { invitationId: invitationId }),
      ),
    ).toBe("not_found");
  });

  test("an email with no account waits until that email is verified at sign-in", async () => {
    const t = invitationsTest();
    const { orgA } = await seed(t);
    await invite(t, orgA, "New@Example.com");
    expect(
      await t.query(api.org.invitations.list, { orgId: orgA }),
    ).toMatchObject([{ email: "new@example.com", hasAccount: false }]);

    const signIn = (emailVerified: boolean): Promise<null> =>
      t.mutation(internal.auth.authKitEvent, {
        event: "user.created",
        data: {
          id: "auth_new",
          email: "new@example.com",
          emailVerified: emailVerified,
        },
      });
    caller.authId = "auth_new";
    await signIn(false);
    expect(await t.query(api.org.invitations.listMine, {})).toEqual([]);
    await signIn(true);
    const [mine] = await t.query(api.org.invitations.listMine, {});
    await t.mutation(api.org.invitations.accept, {
      invitationId: mine!.invitationId,
    });

    expect(await memberIds(t, orgA)).toContain("auth_new");
  });
});

describe("leaving an org", () => {
  test("a member leaves and the dashboard falls back to their other org", async () => {
    const t = invitationsTest();
    const { orgA, orgB } = await seed(t);
    await addMember(t, orgB, "auth_member", "member");
    caller.authId = "auth_member";
    await t.mutation(api.org.orgs.setActive, { orgId: orgA });

    await t.mutation(api.org.members.leave, { orgId: orgA });

    expect(await memberIds(t, orgA)).not.toContain("auth_member");
    expect((await t.query(api.dashboardReads.activeOrg, {}))?._id).toBe(orgB);
  });

  test("the owner cannot leave", async () => {
    const t = invitationsTest();
    const { orgA } = await seed(t);
    caller.authId = "auth_owner";

    await expect(
      t.mutation(api.org.members.leave, { orgId: orgA }),
    ).rejects.toThrow("The owner cannot leave");
    expect(await memberIds(t, orgA)).toContain("auth_owner");
  });
});

async function seed(t: T): Promise<{ orgA: Id<"orgs">; orgB: Id<"orgs"> }> {
  const orgA = await seedOrg(t, "Org A", "auth_owner");
  await addMember(t, orgA, "auth_admin", "admin");
  await addMember(t, orgA, "auth_member", "member");
  const orgB = await seedOrg(t, "Org B", "auth_other");
  await seedUser(t, "auth_guest");
  caller.authId = "auth_admin";

  return { orgA: orgA, orgB: orgB };
}

async function addMember(
  t: T,
  orgId: Id<"orgs">,
  authId: string,
  role: OrgRole,
): Promise<void> {
  const userId = await seedUser(t, authId);
  await t.run(async (ctx) => {
    await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: userId,
      role: role,
      createdAt: Date.now(),
    });
  });
}

async function invite(
  t: T,
  orgId: Id<"orgs">,
  email: string,
): Promise<Id<"orgInvitations">> {
  return await t.mutation(api.org.invitations.create, {
    orgId: orgId,
    email: email,
    role: "admin",
  });
}

async function memberIds(t: T, orgId: Id<"orgs">): Promise<string[]> {
  return await t.run(async (ctx) => {
    const members = await ctx.db
      .query("orgMembers")
      .withIndex("by_orgId_and_userId", (q) => q.eq("orgId", orgId))
      .collect();
    const users = await Promise.all(members.map((m) => ctx.db.get(m.userId)));

    return users.flatMap((user) => (user ? [user.authId] : []));
  });
}

async function refusal(call: Promise<unknown>): Promise<string | undefined> {
  return await call.then(
    () => undefined,
    (error: unknown) => clientErrorData(error)?.code,
  );
}

async function seedOrg(
  t: T,
  name: string,
  ownerAuthId: string,
): Promise<Id<"orgs">> {
  const orgId = await t.run(async (ctx) =>
    ctx.db.insert("orgs", {
      name: name,
      slug: name.toLowerCase().replace(" ", "-"),
      ownerAuthId: ownerAuthId,
      plan: "free",
      createdAt: Date.now(),
    }),
  );
  await addMember(t, orgId, ownerAuthId, "owner");

  return orgId;
}

async function seedUser(t: T, authId: string): Promise<Id<"users">> {
  return await t.run(async (ctx) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", authId))
      .unique();

    return (
      existing?._id ??
      (await ctx.db.insert("users", {
        authId: authId,
        email: `${authId}@example.com`,
        name: authId,
        plan: "free",
      }))
    );
  });
}
