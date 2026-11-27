/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { pkceChallenge } from "../cli/auth";
import { sha256Hex } from "../model/accountSecrets";
import { ClientError } from "../model/clientError";
import schema from "../schema";

// The WorkOS component is not registered in the test runtime; the org admin is the caller.
vi.mock("../auth", () => ({
  authKit: {
    getAuthUser: async () => ({ id: "auth_admin" }),
    registerRoutes: () => undefined,
  },
}));

const modules = import.meta.glob("../**/*.ts");

const AUTH_ID = "auth_admin";
const VERIFIER = "verifier-verifier-verifier-verifier-verifier-1234";

const loginTest = () => convexTest(schema, modules);

type T = ReturnType<typeof loginTest>;

async function seedCode(
  t: T,
  codeChallenge: string,
): Promise<Id<"cliAuthCodes">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: AUTH_ID,
      plan: "free" as const,
      createdAt: now,
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast",
      secretHash: "hash-beeblast",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });

    return await ctx.db.insert("cliAuthCodes", {
      authId: AUTH_ID,
      orgId: orgId,
      accountId: accountId,
      codeChallenge: codeChallenge,
      expiresAt: now + 60_000,
      createdAt: now,
    });
  });
}

describe("CLI login collection with PKCE", () => {
  test("an approved login is collected only with the matching verifier", async () => {
    const t = loginTest();
    await seedCode(t, await pkceChallenge(VERIFIER));

    expect(
      await t.mutation(internal.cli.auth.exchangeLoginCode, {
        codeVerifier: "not-the-verifier",
      }),
    ).toBeNull();

    const exchanged = await t.mutation(internal.cli.auth.exchangeLoginCode, {
      codeVerifier: VERIFIER,
    });
    expect(exchanged?.token.startsWith("bcli_")).toBe(true);
  });

  test("a poll waits for the approval, then collects it once", async () => {
    const t = loginTest();
    const poll = async (): Promise<Response> =>
      await t.fetch("/v1/account/auth/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code_verifier: VERIFIER }),
      });

    const waiting = await poll();
    expect(waiting.status).toBe(202);
    expect(await waiting.json()).toEqual({ pending: true });

    await seedCode(t, await pkceChallenge(VERIFIER));
    const collected = await poll();
    expect(collected.status).toBe(200);
    expect((await collected.json()).token.startsWith("bcli_")).toBe(true);
    expect((await poll()).status).toBe(400);
  });

  test("a row minted without an Approve click is never collected", async () => {
    const t = loginTest();
    const codeId = await seedCode(t, await pkceChallenge(VERIFIER));
    await t.run(async (ctx) => {
      await ctx.db.patch(codeId, { codeHash: "hash-of-a-redirect-code" });
    });

    expect(
      await t.mutation(internal.cli.auth.exchangeLoginCode, {
        codeVerifier: VERIFIER,
      }),
    ).toBeNull();
  });

  test("an exchange without a verifier is refused", async () => {
    const t = loginTest();
    await seedCode(t, await pkceChallenge(VERIFIER));

    const response = await t.fetch("/v1/account/auth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: "Request body must include code_verifier" },
    });
  });

  test("a code whose account was disabled is refused with a reason, not a server error", async () => {
    const t = loginTest();
    const codeId = await seedCode(t, await pkceChallenge(VERIFIER));
    await t.run(async (ctx) => {
      const code = (await ctx.db.get(codeId))!;
      await ctx.db.patch(code.accountId, { status: "disabled" });
    });

    const response = await t.fetch("/v1/account/auth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code_verifier: VERIFIER }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { message: "Account is not active" },
    });
  });

  test("the challenge is the base64url S256 of the verifier", async () => {
    expect(
      await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("broods logout", () => {
  test("revoking a login stops it resolving, and a second revoke is refused", async () => {
    const t = loginTest();
    const codeId = await seedCode(t, await pkceChallenge(VERIFIER));
    await t.run(async (ctx) => {
      const code = (await ctx.db.get(codeId))!;
      const userId = await ctx.db.insert("users", {
        authId: AUTH_ID,
        email: "admin@example.com",
        name: "Admin",
        plan: "free",
      });
      await ctx.db.insert("orgMembers", {
        orgId: code.orgId,
        userId: userId,
        role: "owner",
        createdAt: Date.now(),
      });
    });
    const exchanged = await t.mutation(internal.cli.auth.exchangeLoginCode, {
      codeVerifier: VERIFIER,
    });
    const token = exchanged?.token ?? "";
    const tokenHash = await sha256Hex(token);
    expect(
      await t.mutation(internal.cli.auth.resolveAccountLogin, {
        tokenHash: tokenHash,
      }),
    ).not.toBe(null);

    const revoke = async (): Promise<Response> =>
      await t.fetch("/v1/account/auth/token", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
    expect((await revoke()).status).toBe(204);
    expect(
      await t.mutation(internal.cli.auth.resolveAccountLogin, {
        tokenHash: tokenHash,
      }),
    ).toBe(null);
    expect((await revoke()).status).toBe(401);
  });
});

describe("CLI login approval", () => {
  test("an org with no API account fails with a reason the page can show", async () => {
    const t = loginTest();
    const orgId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        authId: AUTH_ID,
        email: "admin@example.com",
        name: "admin",
        plan: "free",
      });
      const orgId = await ctx.db.insert("orgs", {
        name: "beeblast",
        slug: "beeblast",
        ownerAuthId: AUTH_ID,
        plan: "free",
        createdAt: 1,
      });
      await ctx.db.insert("orgMembers", {
        orgId: orgId,
        userId: userId,
        role: "owner",
        createdAt: 1,
      });

      return orgId;
    });

    const minting = t.mutation(api.cli.auth.approveLogin, {
      codeChallenge: await pkceChallenge(VERIFIER),
      orgId: orgId,
    });

    await expect(minting).rejects.toBeInstanceOf(ClientError);
    await expect(minting).rejects.toThrow(
      "beeblast has no active API account. Set it up under Organization > API Access in the dashboard.",
    );
  });

  test("the login is for the org the approve page showed, not the one active at the click", async () => {
    const t = loginTest();
    const shown = await t.run(async (ctx) => {
      const orgIds = [];
      for (const slug of ["active", "shown"]) {
        const orgId = await ctx.db.insert("orgs", {
          name: slug,
          slug: slug,
          ownerAuthId: AUTH_ID,
          plan: "free",
          createdAt: 1,
        });
        await ctx.db.insert("accounts", {
          orgId: orgId,
          username: slug,
          secretHash: `hash-${slug}`,
          status: "active",
          createdAt: 1,
          updatedAt: 1,
        });
        orgIds.push(orgId);
      }
      const userId = await ctx.db.insert("users", {
        authId: AUTH_ID,
        email: "admin@example.com",
        name: "admin",
        plan: "free",
        activeOrgId: orgIds[0],
      });
      for (const orgId of orgIds) {
        await ctx.db.insert("orgMembers", {
          orgId: orgId,
          userId: userId,
          role: "owner",
          createdAt: 1,
        });
      }

      return orgIds[1];
    });

    await t.mutation(api.cli.auth.approveLogin, {
      codeChallenge: await pkceChallenge(VERIFIER),
      orgId: shown,
    });
    const exchanged = await t.mutation(internal.cli.auth.exchangeLoginCode, {
      codeVerifier: VERIFIER,
    });

    expect(exchanged?.org.slug).toBe("shown");
  });
});

describe("an AuthKit user at /mcp", () => {
  const signIn = (t: T, authId: string, org?: string) =>
    t.query(internal.cli.auth.resolveUserLogin, {
      authId: authId,
      ...(org ? { org: org } : {}),
    });

  async function seedOrg(
    t: T,
    slug: string,
    members: Record<string, "owner" | "admin" | "member">,
  ): Promise<Id<"accounts">> {
    return await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("orgs", {
        name: slug,
        slug: slug,
        ownerAuthId: AUTH_ID,
        plan: "free",
        createdAt: 1,
      });
      for (const [authId, role] of Object.entries(members)) {
        const userId =
          (
            await ctx.db
              .query("users")
              .withIndex("by_authId", (q) => q.eq("authId", authId))
              .unique()
          )?._id ??
          (await ctx.db.insert("users", {
            authId: authId,
            email: `${authId}@example.com`,
            name: authId,
            plan: "free",
          }));
        await ctx.db.insert("orgMembers", {
          orgId: orgId,
          userId: userId,
          role: role,
          createdAt: 1,
        });
      }

      return await ctx.db.insert("accounts", {
        orgId: orgId,
        username: slug,
        secretHash: `hash-${slug}`,
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      });
    });
  }

  test("an owner gets the org's account, a member a reason", async () => {
    const t = loginTest();
    const accountId = await seedOrg(t, "beeblast", {
      [AUTH_ID]: "owner",
      auth_member: "member",
    });

    const owner = await signIn(t, AUTH_ID);
    expect("account" in owner && owner.account._id).toBe(accountId);
    expect(await signIn(t, "auth_member")).toEqual({
      refused:
        "Signing in to Broods needs the owner or admin role in an organization.",
    });
  });

  test("an admin of several orgs names one in the URL, whatever the dashboard shows", async () => {
    const t = loginTest();
    const acme = await seedOrg(t, "acme", { [AUTH_ID]: "owner" });
    await seedOrg(t, "globex", { [AUTH_ID]: "owner" });

    expect(await signIn(t, AUTH_ID)).toEqual({
      refused:
        "You administer several organizations. Add ?org=<slug> to the MCP URL to pick one: acme, globex.",
    });
    const picked = await signIn(t, AUTH_ID, "acme");
    expect("account" in picked && picked.account._id).toBe(acme);
    expect(await signIn(t, AUTH_ID, "initech")).toEqual({
      refused:
        "You are not an owner or admin of an organization with the slug initech.",
    });
  });

  test("the sign-in page offers the orgs they administer, the dashboard's one first", async () => {
    const t = loginTest();
    await seedOrg(t, "acme", { [AUTH_ID]: "owner" });
    await seedOrg(t, "globex", { [AUTH_ID]: "admin" });
    await seedOrg(t, "initech", { [AUTH_ID]: "member" });
    await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_authId", (q) => q.eq("authId", AUTH_ID))
        .unique();
      const hooli = await ctx.db.insert("orgs", {
        name: "hooli",
        slug: "hooli",
        ownerAuthId: AUTH_ID,
        plan: "free",
        createdAt: 1,
      });
      await ctx.db.insert("orgMembers", {
        orgId: hooli,
        userId: user!._id,
        role: "owner",
        createdAt: 1,
      });
    });
    await t.run(async (ctx) => {
      const globex = await ctx.db
        .query("orgs")
        .withIndex("by_slug", (q) => q.eq("slug", "globex"))
        .unique();
      const user = await ctx.db
        .query("users")
        .withIndex("by_authId", (q) => q.eq("authId", AUTH_ID))
        .unique();
      await ctx.db.patch(user!._id, { activeOrgId: globex!._id });
    });

    const offered = await t.query(api.cli.auth.mcpSignInOrgs, {});
    expect(offered.map(({ orgId: _orgId, ...rest }) => rest)).toEqual([
      {
        slug: "globex",
        name: "globex",
        role: "admin",
        selected: true,
        provisioned: true,
      },
      {
        slug: "acme",
        name: "acme",
        role: "owner",
        selected: false,
        provisioned: true,
      },
      {
        slug: "hooli",
        name: "hooli",
        role: "owner",
        selected: false,
        provisioned: false,
      },
    ]);
  });
});
