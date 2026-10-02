/// <reference types="vite/client" />
/**
 * `/v1/account/connections`: a sign-in is stored encrypted and read back
 * without its tokens or client secret, each type's rules hold (ChatGPT plan
 * usage, a Google client secret), the managed service refuses ChatGPT only,
 * core's refresh never overwrites a newer sign-in, and a disconnect forgets,
 * then revokes.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { sha256Hex } from "../model/accountSecrets";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const ACCOUNT_SECRET = "fp_acct_test-owner-secret";

const connectionsTest = () => convexTest(schema, modules);

type T = ReturnType<typeof connectionsTest>;

const chatgpt = {
  type: "chatgpt",
  clientId: "client-1",
  hostId: "urn:uuid:host-1",
  email: "user@example.com",
  scopes: ["openid", "offline_access", "chatgpt.tokens.use.direct"],
  expiresAt: "2026-10-02T12:00:00.000Z",
  accessToken: "access-1",
  refreshToken: "refresh-1",
};

const google = {
  type: "google",
  clientId: "google-client",
  clientSecret: "google-secret",
  email: "user@example.com",
  scopes: ["openid", "https://www.googleapis.com/auth/gmail.modify"],
  expiresAt: "2026-10-02T12:00:00.000Z",
  accessToken: "access-g",
  refreshToken: "refresh-g",
};

beforeEach(() => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("a stored sign-in reads back without its tokens or client secret", async () => {
  const t = connectionsTest();
  const accountId = await seedAccount(t);

  expect((await request(t, "PUT", "chatgpt", chatgpt)).status).toBe(200);
  expect((await request(t, "PUT", "gmail", google)).status).toBe(200);
  const one = await (await request(t, "GET", "chatgpt")).json();
  const all = await (await request(t, "GET")).json();

  expect(one).toEqual({
    name: "chatgpt",
    type: "chatgpt",
    clientId: "client-1",
    hostId: "urn:uuid:host-1",
    email: "user@example.com",
    scopes: chatgpt.scopes,
    expiresAt: chatgpt.expiresAt,
    updatedAt: expect.any(String),
  });
  expect(all.connections.map((c: { name: string }) => c.name)).toEqual([
    "chatgpt",
    "gmail",
  ]);
  for (const secret of ["access-1", "refresh-g", "google-secret"]) {
    expect(JSON.stringify(all)).not.toContain(secret);
  }
  const loaded = await t.query(internal.account.connections.load, {
    accountId: accountId,
    name: "gmail",
  });
  expect(loaded).toMatchObject({
    accessToken: "access-g",
    refreshToken: "refresh-g",
    clientSecret: "google-secret",
  });
  const rows = await t.run(async (ctx) =>
    ctx.db.query("connections").collect(),
  );
  expect(JSON.stringify(rows)).not.toContain("refresh-1");
});

test("each type's sign-in rules hold", async () => {
  const t = connectionsTest();
  await seedAccount(t);

  const noPlanUsage = await request(t, "PUT", "chatgpt", {
    ...chatgpt,
    scopes: ["openid", "offline_access"],
  });
  const misnamed = await request(t, "PUT", "my-chatgpt", chatgpt);
  const noSecret = await request(t, "PUT", "gmail", {
    ...google,
    clientSecret: undefined,
  });
  const badName = await request(t, "PUT", "Gmail_Work", google);

  expect(noPlanUsage.status).toBe(400);
  expect(misnamed.status).toBe(400);
  expect(noSecret.status).toBe(400);
  expect(badName.status).toBe(400);
  expect(await (await request(t, "GET")).json()).toEqual({ connections: [] });
  expect((await request(t, "GET", "gmail")).status).toBe(404);
});

test("the managed service refuses ChatGPT only", async () => {
  vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
  const t = connectionsTest();
  await seedAccount(t);

  expect((await request(t, "PUT", "chatgpt", chatgpt)).status).toBe(403);
  expect((await request(t, "PUT", "gmail", google)).status).toBe(200);
});

test("a refresh never overwrites a newer sign-in", async () => {
  const t = connectionsTest();
  const accountId = await seedAccount(t);
  await request(t, "PUT", "chatgpt", chatgpt);
  const ref = { accountId: accountId, name: "chatgpt" };
  const loaded = await t.query(internal.account.connections.load, ref);
  const refreshed = {
    ...ref,
    loadedUpdatedAt: loaded!.updatedAt,
    expiresAt: Date.now() + 600_000,
    accessToken: "access-2",
    refreshToken: "refresh-2",
  };

  vi.useFakeTimers({ now: loaded!.updatedAt + 1000 });
  await request(t, "PUT", "chatgpt", { ...chatgpt, accessToken: "access-new" });
  vi.useRealTimers();
  const saved = await t.mutation(
    internal.account.connections.saveRefreshed,
    refreshed,
  );

  expect(saved).toBe(false);
  expect(
    (await t.query(internal.account.connections.load, ref))?.accessToken,
  ).toBe("access-new");
});

test("a disconnect forgets the connection, then revokes it", async () => {
  vi.useFakeTimers();
  const t = connectionsTest();
  await seedAccount(t);
  await request(t, "PUT", "gmail", google);
  const revoked: Array<{ url: string; form: URLSearchParams }> = [];
  vi.stubGlobal(
    "fetch",
    async (input: string, init?: RequestInit): Promise<Response> => {
      revoked.push({
        url: input,
        form: new URLSearchParams(init?.body as URLSearchParams),
      });

      return new Response(null, { status: 200 });
    },
  );

  const response = await request(t, "DELETE", "gmail");
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  expect(await response.json()).toEqual({ deleted: true });
  expect(revoked).toHaveLength(1);
  expect(revoked[0]?.url).toBe("https://oauth2.googleapis.com/revoke");
  expect(revoked[0]?.form.get("token")).toBe("refresh-g");
  expect(revoked[0]?.form.get("client_secret")).toBe("google-secret");
  expect((await request(t, "GET", "gmail")).status).toBe(404);
});

async function request(
  t: T,
  method: "GET" | "PUT" | "DELETE",
  name?: string,
  body?: unknown,
): Promise<Response> {
  return await t.fetch(
    `/v1/account/connections${name !== undefined ? `/${name}` : ""}`,
    {
      method: method,
      headers: {
        Authorization: `Bearer ${ACCOUNT_SECRET}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
  );
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
