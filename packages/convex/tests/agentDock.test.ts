/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { sha256Hex } from "../model/accountSecrets";
import type { Id } from "../_generated/dataModel";
import { openUserToken } from "../model/userToken";
import schema from "../schema";

const AUTH_ID = "user_01DOCKTEST";
const SIGNING_SECRET = "bsig_dock-test";

// The mutation reads its caller through the WorkOS component, absent from the test runtime.
vi.mock("../auth", () => ({
  authKit: { getAuthUser: async () => ({ id: AUTH_ID }) },
}));

const modules = import.meta.glob("../**/*.ts");

const dockTest = (): TestConvex<typeof schema> => convexTest(schema, modules);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("agentDock.session", () => {
  test("is null on a deployment with no Broods agent configured", async () => {
    expect(await dockTest().mutation(api.agentDock.session, {})).toBeNull();
  });

  test("hands the dock the agent and a user token for the signed-in user", async () => {
    stubDockAgent();

    const session = await dockTest().mutation(api.agentDock.session, {});

    expect(session).toMatchObject({
      agentId: "agent_1",
      runtimeKey: "bsk_runtime",
      url: "https://gateway.example.com/v1/projects/broods/stages/production/agents/ep_1",
    });
    const opened = await openUserToken(
      session?.userToken ?? "",
      SIGNING_SECRET,
    );
    expect(opened).toMatchObject({ userId: AUTH_ID });
    expect(opened?.conversations).toBeUndefined();
  });

  test("an admin's token carries a CLI login that dies with it", async () => {
    stubDockAgent();
    const t = dockTest();
    const accountId = await seedOrg(t, "admin");

    const session = await t.mutation(api.agentDock.session, {});
    const opened = await openUserToken(
      session?.userToken ?? "",
      SIGNING_SECRET,
    );
    const credential = opened?.credential ?? "";

    expect(credential.startsWith("bcli_")).toBe(true);
    const tokenHash = await sha256Hex(credential);
    const login = await t.mutation(internal.cli.auth.resolveAccountLogin, {
      tokenHash: tokenHash,
    });
    expect(login).toMatchObject({
      account: { _id: accountId },
      authId: AUTH_ID,
      lentToAgent: true,
    });
    expect(
      await t.mutation(internal.cli.auth.resolveCliToken, {
        tokenHash: tokenHash,
      }),
    ).toBeNull();
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("cliTokens")
        .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
        .unique(),
    );
    expect(row?.expiresAt).toBe(session?.expiresAt);
    expect(
      await t.mutation(internal.cli.auth.pruneExpiredTokens, {
        now: (session?.expiresAt ?? 0) + 1,
      }),
    ).toEqual({ tokensDeleted: 1 });
  });

  test("a member's token carries no credential", async () => {
    stubDockAgent();
    const t = dockTest();
    await seedOrg(t, "member");

    const session = await t.mutation(api.agentDock.session, {});
    const opened = await openUserToken(
      session?.userToken ?? "",
      SIGNING_SECRET,
    );

    expect(opened).toMatchObject({ userId: AUTH_ID });
    expect(opened?.credential).toBeUndefined();
    expect(
      await t.run(async (ctx) => ctx.db.query("cliTokens").collect()),
    ).toEqual([]);
  });
});

function stubDockAgent(): void {
  vi.stubEnv(
    "BROODS_AGENT_URL",
    "https://gateway.example.com/v1/projects/broods/stages/production/agents/ep_1",
  );
  vi.stubEnv("BROODS_AGENT_ID", "agent_1");
  vi.stubEnv("BROODS_AGENT_RUNTIME_KEY", "bsk_runtime");
  vi.stubEnv("BROODS_AGENT_USER_TOKEN_SECRET", SIGNING_SECRET);
}

async function seedOrg(
  t: TestConvex<typeof schema>,
  role: "admin" | "member",
): Promise<Id<"accounts">> {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", {
      name: "acme",
      slug: "acme",
      ownerAuthId: "user_owner",
      plan: "free",
      createdAt: Date.now(),
    });
    const userId = await ctx.db.insert("users", {
      authId: AUTH_ID,
      email: "dock@example.com",
      name: "Dock",
      plan: "free",
      activeOrgId: orgId,
    });
    await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: userId,
      role: role,
      createdAt: Date.now(),
    });

    return await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "acme",
      secretHash: "hash",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}
