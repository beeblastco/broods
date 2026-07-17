/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const orgTest = () => convexTest(schema, modules);

type T = ReturnType<typeof orgTest>;

async function seedAccount(
  t: T,
  orgId: string,
  username = "beeblast-sale-agent-dev",
) {
  return await t.run(
    async (ctx) =>
      await ctx.db.insert("accounts", {
        orgId,
        username,
        description: "sale-agent-usecase dev stack tenant account",
        secretHash: "hash-" + username,
        status: "active" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
  );
}

async function seedUser(t: T, email: string) {
  return await t.run(
    async (ctx) =>
      await ctx.db.insert("users", {
        authId: "auth_" + email,
        email,
        name: "Test Owner",
        plan: "free" as const,
      }),
  );
}

const adopt = (
  t: T,
  args: { accountId: any; ownerEmail: string; orgName: string },
) => t.mutation(internal.org.adoptExternalAccount, args);

describe("adoptExternalAccount", () => {
  test("binds an external account to a new org owned by the target user", async () => {
    const t = orgTest();
    const accountId = await seedAccount(t, "external:sale-agent-dev");
    const userId = await seedUser(t, "owner@example.com");

    const result = await adopt(t, {
      accountId,
      ownerEmail: "owner@example.com",
      orgName: "BeeBlast Sale Agent (dev)",
    });

    await t.run(async (ctx) => {
      const account = await ctx.db.get(accountId);
      // The account now points at a real org document, not the synthetic string.
      expect(account?.orgId).toBe(result.orgId);
      // Untouched: the service holding this secret keeps working.
      expect(account?.secretHash).toBe("hash-beeblast-sale-agent-dev");

      const org = await ctx.db.get(result.orgId);
      expect(org?.name).toBe("BeeBlast Sale Agent (dev)");
      expect(org?.ownerAuthId).toBe("auth_owner@example.com");

      const membership = await ctx.db.get(result.membershipId);
      expect(membership).toMatchObject({
        orgId: result.orgId,
        userId,
        role: "owner",
      });
    });
  });

  test("the adopted account is now reachable the way the dashboard reaches accounts", async () => {
    const t = orgTest();
    const accountId = await seedAccount(t, "external:sale-agent-dev");
    await seedUser(t, "owner@example.com");

    const { orgId } = await adopt(t, {
      accountId,
      ownerEmail: "owner@example.com",
      orgName: "BeeBlast Sale Agent (dev)",
    });

    // getByOrgId resolves with .unique(); this is the query that was previously
    // unreachable for this account, and that would throw on a duplicate binding.
    const found = await t.query(internal.accounts.getByOrgId, { orgId });
    expect(found?._id).toBe(accountId);
  });

  test("refuses to move an account a real org already owns", async () => {
    const t = orgTest();
    // A dashboard-signup account, bound to a genuine org id.
    const orgId = await t.run(
      async (ctx) =>
        await ctx.db.insert("orgs", {
          name: "Someone's Workspace",
          slug: "someones-workspace",
          ownerAuthId: "auth_someone",
          plan: "free" as const,
          createdAt: Date.now(),
        }),
    );
    const accountId = await seedAccount(t, orgId, "someones-workspace");
    await seedUser(t, "owner@example.com");

    await expect(
      adopt(t, {
        accountId,
        ownerEmail: "owner@example.com",
        orgName: "Hijack",
      }),
    ).rejects.toThrow(/refusing to move it/);
  });

  test("refuses an owner who has never signed in", async () => {
    const t = orgTest();
    const accountId = await seedAccount(t, "external:sale-agent-dev");

    await expect(
      adopt(t, { accountId, ownerEmail: "ghost@example.com", orgName: "Nope" }),
    ).rejects.toThrow(/must sign in/);
  });

  test("leaves the owner's existing org and its account intact", async () => {
    const t = orgTest();
    // The owner already has a workspace org with its own account — the exact
    // collision that makes re-pointing onto an existing org unsafe.
    const existingOrgId = await t.run(
      async (ctx) =>
        await ctx.db.insert("orgs", {
          name: "owner's Workspace",
          slug: "owners-workspace",
          ownerAuthId: "auth_owner@example.com",
          plan: "free" as const,
          createdAt: Date.now(),
        }),
    );
    const existingAccountId = await seedAccount(
      t,
      existingOrgId,
      "owners-workspace",
    );
    const accountId = await seedAccount(t, "external:sale-agent-dev");
    await seedUser(t, "owner@example.com");

    const { orgId } = await adopt(t, {
      accountId,
      ownerEmail: "owner@example.com",
      orgName: "BeeBlast Sale Agent (dev)",
    });

    expect(orgId).not.toBe(existingOrgId);
    // The pre-existing org still resolves to exactly its own account.
    const existing = await t.query(internal.accounts.getByOrgId, {
      orgId: existingOrgId,
    });
    expect(existing?._id).toBe(existingAccountId);
  });

  test("gives each adopted account a distinct slug", async () => {
    const t = orgTest();
    const first = await seedAccount(t, "external:sale-agent-dev", "acct-dev");
    const second = await seedAccount(
      t,
      "external:sale-agent-prod",
      "acct-prod",
    );
    await seedUser(t, "owner@example.com");

    const a = await adopt(t, {
      accountId: first,
      ownerEmail: "owner@example.com",
      orgName: "BeeBlast Sale Agent",
    });
    const b = await adopt(t, {
      accountId: second,
      ownerEmail: "owner@example.com",
      orgName: "BeeBlast Sale Agent",
    });

    expect(a.slug).not.toBe(b.slug);
  });
});
