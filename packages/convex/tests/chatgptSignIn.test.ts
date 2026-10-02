/// <reference types="vite/client" />
/**
 * `/v1/account/chatgpt`: a sign-in is stored encrypted and read back without
 * its tokens, only a grant that allows plan usage is accepted, the managed
 * service refuses it, and neither core's refresh nor a logout touches a newer
 * sign-in.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { sha256Hex } from "../model/accountSecrets";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const ACCOUNT_SECRET = "fp_acct_test-owner-secret";

const signInTest = () => convexTest(schema, modules);

type T = ReturnType<typeof signInTest>;

const signIn = {
  clientId: "client-1",
  hostId: "urn:uuid:host-1",
  email: "user@example.com",
  scopes: ["openid", "offline_access", "chatgpt.tokens.use.direct"],
  expiresAt: "2026-10-02T12:00:00.000Z",
  accessToken: "access-1",
  refreshToken: "refresh-1",
};

beforeEach(() => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("a stored sign-in reads back without its tokens", async () => {
  const t = signInTest();
  const accountId = await seedAccount(t);

  const put = await request(t, "PUT", signIn);
  expect(put.status).toBe(200);
  const status = await (await request(t, "GET")).json();

  expect(status).toEqual({
    connected: true,
    clientId: "client-1",
    hostId: "urn:uuid:host-1",
    email: "user@example.com",
    scopes: signIn.scopes,
    planUsage: true,
    expiresAt: signIn.expiresAt,
    updatedAt: expect.any(String),
  });
  expect(JSON.stringify(status)).not.toContain("access-1");
  const loaded = await t.query(internal.account.providerCredentials.load, {
    accountId: accountId,
    provider: "chatgpt",
  });
  expect(loaded).toMatchObject({
    accessToken: "access-1",
    refreshToken: "refresh-1",
  });
  const row = await t.run(async (ctx) =>
    ctx.db.query("providerCredentials").first(),
  );
  expect(JSON.stringify(row)).not.toContain("refresh-1");
});

test("a sign-in without plan usage is refused", async () => {
  const t = signInTest();
  await seedAccount(t);

  const response = await request(t, "PUT", {
    ...signIn,
    scopes: ["openid", "offline_access"],
  });

  expect(response.status).toBe(400);
  expect(await (await request(t, "GET")).json()).toEqual({ connected: false });
});

test("the managed service refuses a sign-in", async () => {
  vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
  const t = signInTest();
  await seedAccount(t);

  const response = await request(t, "PUT", signIn);

  expect(response.status).toBe(403);
});

test("a refresh never overwrites a newer sign-in", async () => {
  const t = signInTest();
  const accountId = await seedAccount(t);
  await request(t, "PUT", signIn);
  const ref = { accountId: accountId, provider: "chatgpt" as const };
  const loaded = await t.query(internal.account.providerCredentials.load, ref);
  const refreshed = {
    ...ref,
    loadedUpdatedAt: loaded!.updatedAt,
    scopes: signIn.scopes,
    expiresAt: Date.now() + 600_000,
    accessToken: "access-2",
    refreshToken: "refresh-2",
  };

  vi.useFakeTimers({ now: loaded!.updatedAt + 1000 });
  await request(t, "PUT", { ...signIn, accessToken: "access-new" });
  vi.useRealTimers();
  const saved = await t.mutation(
    internal.account.providerCredentials.saveRefreshed,
    refreshed,
  );

  expect(saved).toBe(false);
  expect(
    (await t.query(internal.account.providerCredentials.load, ref))
      ?.accessToken,
  ).toBe("access-new");
});

test("a logout never removes a newer sign-in", async () => {
  const t = signInTest();
  const accountId = await seedAccount(t);
  await request(t, "PUT", signIn);
  const ref = { accountId: accountId, provider: "chatgpt" as const };
  const loaded = await t.query(internal.account.providerCredentials.load, ref);

  vi.useFakeTimers({ now: loaded!.updatedAt + 1000 });
  await request(t, "PUT", { ...signIn, accessToken: "access-new" });
  vi.useRealTimers();
  const removed = await t.mutation(
    internal.account.providerCredentials.remove,
    { ...ref, loadedUpdatedAt: loaded!.updatedAt },
  );

  expect(removed).toBe(false);
  expect(
    (await t.query(internal.account.providerCredentials.load, ref))
      ?.accessToken,
  ).toBe("access-new");
});

test("logging out revokes the refresh token, then forgets it", async () => {
  const t = signInTest();
  await seedAccount(t);
  await request(t, "PUT", signIn);
  const revoked: URLSearchParams[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: string, init?: RequestInit): Promise<Response> => {
      if (input.endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          revocation_endpoint: "https://auth.openai.com/oauth/revoke",
        });
      }
      revoked.push(new URLSearchParams(init?.body as URLSearchParams));

      return new Response(null, { status: 200 });
    },
  );

  const response = await request(t, "DELETE");

  expect(await response.json()).toEqual({ deleted: true });
  expect(revoked[0]?.get("token")).toBe("refresh-1");
  expect(revoked[0]?.get("token_type_hint")).toBe("refresh_token");
  expect(revoked[0]?.get("client_id")).toBe("client-1");
  expect(await (await request(t, "GET")).json()).toEqual({ connected: false });
});

async function request(
  t: T,
  method: "GET" | "PUT" | "DELETE",
  body?: unknown,
): Promise<Response> {
  return await t.fetch("/v1/account/chatgpt", {
    method: method,
    headers: {
      Authorization: `Bearer ${ACCOUNT_SECRET}`,
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function seedAccount(t: T): Promise<Id<"accounts">> {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: "auth_owner",
      plan: "free" as const,
      createdAt: Date.now(),
    });

    return await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast",
      secretHash: await sha256Hex(ACCOUNT_SECRET),
      status: "active" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}
