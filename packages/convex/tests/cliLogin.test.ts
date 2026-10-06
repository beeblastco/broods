/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { pkceChallenge } from "../cli/auth";
import { sha256Hex } from "../model/accountSecrets";
import { ClientError } from "../model/clientError";
import schema from "../schema";

// The WorkOS component is not registered in the test runtime; the org admin
// below is the caller.
vi.mock("../auth", () => ({
  authKit: {
    getAuthUser: async () => ({ id: "auth_admin" }),
    registerRoutes: () => undefined,
  },
}));

const modules = import.meta.glob("../**/*.ts");

const AUTH_ID = "auth_admin";
const CODE = "bcode_test-code";
const VERIFIER = "verifier-verifier-verifier-verifier-verifier-1234";

const loginTest = () => convexTest(schema, modules);

type T = ReturnType<typeof loginTest>;

async function seedCode(
  t: T,
  codeChallenge: string,
  code: string = CODE,
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
      codeHash: await sha256Hex(code),
      authId: AUTH_ID,
      orgId: orgId,
      accountId: accountId,
      codeChallenge: codeChallenge,
      expiresAt: now + 60_000,
      createdAt: now,
    });
  });
}

describe("CLI login code exchange with PKCE", () => {
  test("a code minted with a challenge needs the matching verifier", async () => {
    const t = loginTest();
    await seedCode(t, await pkceChallenge(VERIFIER));

    await expect(
      t.mutation(internal.cli.auth.exchangeLoginCode, {
        code: CODE,
        codeVerifier: "not-the-verifier",
      }),
    ).rejects.toThrow(/invalid or expired/);

    const exchanged = await t.mutation(internal.cli.auth.exchangeLoginCode, {
      code: CODE,
      codeVerifier: VERIFIER,
    });
    expect(exchanged.token.startsWith("bcli_")).toBe(true);
  });

  test("an exchange without a verifier is refused", async () => {
    const t = loginTest();
    await seedCode(t, await pkceChallenge(VERIFIER));

    const response = await t.fetch("/v1/account/auth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: CODE }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: "Request body must include code_verifier" },
    });
  });

  test("a code under an old prefix is refused even when its hash is stored", async () => {
    const t = loginTest();
    const legacy = "fp_code_test-code";
    await seedCode(t, await pkceChallenge(VERIFIER), legacy);

    await expect(
      t.mutation(internal.cli.auth.exchangeLoginCode, {
        code: legacy,
        codeVerifier: VERIFIER,
      }),
    ).rejects.toThrow(/invalid or expired/);
  });

  test("the challenge is the base64url S256 of the verifier", async () => {
    expect(
      await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("CLI login code minting", () => {
  test("an org with no API account fails with a reason the CLI can show", async () => {
    const t = loginTest();
    await t.run(async (ctx) => {
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
    });

    const minting = t.mutation(api.cli.auth.createLoginCode, {
      codeChallenge: await pkceChallenge(VERIFIER),
    });

    await expect(minting).rejects.toBeInstanceOf(ClientError);
    await expect(minting).rejects.toThrow(
      "beeblast has no active API account. Set it up under Organization > API Access in the dashboard.",
    );
  });
});
