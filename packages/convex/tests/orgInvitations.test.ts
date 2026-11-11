/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { clientErrorData } from "../model/clientError";
import { developersOf } from "../model/orgBilling";
import type { OrgRole } from "../model/ownership/org";
import schema from "../schema";

const caller = vi.hoisted(() => ({
  authId: "auth_admin",
  email: undefined as string | undefined,
  emailVerified: true,
}));

vi.mock("../auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth")>()),
  authKit: {
    getAuthUser: async () => ({
      id: caller.authId,
      email: caller.email ?? `${caller.authId}@example.com`,
      emailVerified: caller.emailVerified,
    }),
  },
}));

const modules = import.meta.glob("../**/*.ts");

const invitationsTest = (): TestConvex<typeof schema> =>
  convexTest(schema, modules);

type T = ReturnType<typeof invitationsTest>;

afterEach(() => {
  caller.email = undefined;
  caller.emailVerified = true;
  vi.unstubAllEnvs();
});

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

    caller.authId = "auth_new";
    caller.email = "new@example.com";
    await signIn(t, "user.created", "new@example.com", false);
    expect(await t.query(api.org.invitations.listMine, {})).toEqual([]);
    await signIn(t, "user.updated", "new@example.com", true);
    const [mine] = await t.query(api.org.invitations.listMine, {});
    await t.mutation(api.org.invitations.accept, {
      invitationId: mine!.invitationId,
    });

    expect(await memberIds(t, orgA)).toContain("auth_new");
  });

  test("an account whose email is not verified cannot answer its invitation", async () => {
    const t = invitationsTest();
    const { orgA } = await seed(t);
    const invitationId = await invite(t, orgA, "auth_guest@example.com");
    caller.authId = "auth_guest";
    caller.emailVerified = false;

    for (const answer of [
      api.org.invitations.accept,
      api.org.invitations.decline,
    ]) {
      await expect(
        t.mutation(answer, { invitationId: invitationId }),
      ).rejects.toThrow("Verify your email address");
    }
    expect(await memberIds(t, orgA)).not.toContain("auth_guest");
  });

  test("an email signed in with capitals finds its account", async () => {
    const t = invitationsTest();
    const { orgA } = await seed(t);
    await signIn(t, "user.created", "Alice@Example.com", true);
    await invite(t, orgA, "alice@example.com");

    expect(
      await t.query(api.org.invitations.list, { orgId: orgA }),
    ).toMatchObject([{ email: "alice@example.com", hasAccount: true }]);
    caller.authId = "auth_new";
    expect(await t.query(api.org.invitations.listMine, {})).toHaveLength(1);
  });

  test("one person holds one seat, by email before their account is verified and by id after", async () => {
    const t = invitationsTest();
    const { orgA } = await seed(t);
    const orgC = await seedOrg(t, "Org C", "auth_owner");
    await invite(t, orgA, "new@example.com");
    await signIn(t, "user.created", "new@example.com", false);
    caller.authId = "auth_owner";
    await invite(t, orgC, "new@example.com");

    const developers = await t.run(
      async (ctx) => (await developersOf(ctx, "auth_owner")).size,
    );
    expect(developers).toBe(3);
  });

  test("claiming an invitation at sign-in recounts the owner's seats", async () => {
    const t = invitationsTest();
    const { orgA } = await seed(t);
    await t.run(async (ctx) => {
      const admin = await ctx.db
        .query("users")
        .withIndex("by_authId", (q) => q.eq("authId", "auth_admin"))
        .unique();
      await ctx.db.insert("orgInvitations", {
        orgId: orgA,
        email: "new@example.com",
        role: "member",
        invitedBy: admin!._id,
        createdAt: Date.now(),
      });
    });
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    await signIn(t, "user.created", "new@example.com", true);

    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(
      scheduled.map(({ name, args }) => ({ name: name, args: args })),
    ).toEqual([
      { name: "stripe:syncSeatsInternal", args: [{ authId: "auth_owner" }] },
    ]);
  });

  test("an invitation dies with its inviter's power to grant it", async () => {
    const t = invitationsTest();
    const { orgA } = await seed(t);
    const invitationId = await invite(t, orgA, "auth_guest@example.com");
    caller.authId = "auth_owner";
    await t.mutation(api.org.members.updateRole, {
      membershipId: await membershipOf(t, orgA, "auth_admin"),
      role: "member",
    });

    caller.authId = "auth_guest";
    expect(
      await t.mutation(api.org.invitations.accept, {
        invitationId: invitationId,
      }),
    ).toBe("This invitation is no longer valid.");
    expect(await memberIds(t, orgA)).not.toContain("auth_guest");
    expect(await t.query(api.org.invitations.listMine, {})).toEqual([]);
  });

  test("an account whose email changed cannot accept an invitation sent to its old address", async () => {
    const t = invitationsTest();
    const { orgA } = await seed(t);
    const invitationId = await invite(t, orgA, "auth_guest@example.com");
    caller.authId = "auth_guest";
    caller.email = "mallory@example.org";

    await expect(
      t.mutation(api.org.invitations.accept, { invitationId: invitationId }),
    ).rejects.toThrow("an address you no longer sign in with");
    expect(await memberIds(t, orgA)).not.toContain("auth_guest");
    caller.email = "Auth_Guest@Example.com";
    await t.mutation(api.org.invitations.accept, {
      invitationId: invitationId,
    });
    expect(await memberIds(t, orgA)).toContain("auth_guest");
  });

  test("an account whose email changed can still decline", async () => {
    const t = invitationsTest();
    const { orgA } = await seed(t);
    const invitationId = await invite(t, orgA, "auth_guest@example.com");
    caller.authId = "auth_guest";
    caller.email = "mallory@example.org";

    await t.mutation(api.org.invitations.decline, {
      invitationId: invitationId,
    });

    expect(await t.run((ctx) => ctx.db.get(invitationId))).toBeNull();
    expect(await memberIds(t, orgA)).not.toContain("auth_guest");
  });

  test("deleting an account that claimed an invitation it sent itself finishes", async () => {
    const t = invitationsTest();
    const { orgA } = await seed(t);
    const invitationId = await invite(t, orgA, "new@example.com");
    await t.run(async (ctx) => {
      const invitation = await ctx.db.get(invitationId);
      await ctx.db.patch(invitationId, { userId: invitation!.invitedBy });
    });

    await t.mutation(internal.org.workosUserDeletion.finalize, {
      authId: "auth_admin",
    });

    expect(
      await t.run((ctx) => ctx.db.query("orgInvitations").collect()),
    ).toEqual([]);
  });

  test.each([
    "they are removed",
    "they leave",
    "their account is deleted",
  ] as const)(
    "an inviter's invitations go when %s, with one seat recount",
    async (exit) => {
      const t = invitationsTest();
      const { orgA } = await seed(t);
      await invite(t, orgA, "auth_guest@example.com");
      await invite(t, orgA, "new@example.com");
      vi.stubEnv("BROODS_MANAGED_SERVICE", "true");

      if (exit === "they are removed") {
        caller.authId = "auth_owner";
        await t.mutation(api.org.members.remove, {
          membershipId: await membershipOf(t, orgA, "auth_admin"),
        });
      } else if (exit === "they leave") {
        await t.mutation(api.org.members.leave, { orgId: orgA });
      } else {
        await t.mutation(internal.org.workosUserDeletion.finalize, {
          authId: "auth_admin",
        });
      }

      const { invitations, guestInvited, recounts } = await t.run(
        async (ctx) => ({
          invitations: await ctx.db.query("orgInvitations").collect(),
          guestInvited: (
            await ctx.db
              .query("users")
              .withIndex("by_authId", (q) => q.eq("authId", "auth_guest"))
              .unique()
          )?.invited,
          recounts: (
            await ctx.db.system.query("_scheduled_functions").collect()
          ).filter(({ name }) => name === "stripe:syncSeatsInternal"),
        }),
      );
      expect(invitations).toEqual([]);
      expect(guestInvited).toBeUndefined();
      expect(recounts.map(({ args }) => args)).toEqual([
        [{ authId: "auth_owner" }],
      ]);
    },
  );

  test("an address not shaped like an email is refused", async () => {
    const t = invitationsTest();
    const { orgA } = await seed(t);

    for (const email of ["name", "name@example", "a b@example.com", "@x.io"]) {
      expect(await refusal(invite(t, orgA, email))).toBe("invalid_request");
    }
  });

  test("the audit log names the email an invitation went to, with or without an account", async () => {
    const t = invitationsTest();
    const { orgA } = await seed(t);
    await t.run(async (ctx) =>
      ctx.db.insert("accounts", {
        orgId: orgA,
        username: "org-a",
        secretHash: "hash-org-a",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const invitationId = await invite(t, orgA, "new@example.com");
    await t.mutation(api.org.invitations.revoke, {
      invitationId: invitationId,
    });

    const events = await t.run(async (ctx) =>
      ctx.db.query("auditEvents").collect(),
    );
    expect(events.map((event) => [event.action, event.resource.name])).toEqual([
      ["invited", "new@example.com"],
      ["invitation-revoked", "new@example.com"],
    ]);
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

async function membershipOf(
  t: T,
  orgId: Id<"orgs">,
  authId: string,
): Promise<Id<"orgMembers">> {
  return await t.run(async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", authId))
      .unique();
    const membership = await ctx.db
      .query("orgMembers")
      .withIndex("by_orgId_and_userId", (q) =>
        q.eq("orgId", orgId).eq("userId", user!._id),
      )
      .unique();

    return membership!._id;
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

async function signIn(
  t: T,
  event: "user.created" | "user.updated",
  email: string,
  emailVerified: boolean,
): Promise<null> {
  return await t.mutation(internal.auth.authKitEvent, {
    event: event,
    data: { id: "auth_new", email: email, emailVerified: emailVerified },
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
