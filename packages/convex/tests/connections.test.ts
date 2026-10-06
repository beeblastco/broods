/// <reference types="vite/client" />
/**
 * `/v1/account/connections`: `start` answers the provider's consent screen on
 * the right client, a PUT trades the code and stores the connection only after
 * its ID token verifies and the type's rules hold, the stored tokens never
 * leave, the managed service refuses ChatGPT, a refresh never overwrites a
 * newer sign-in, and a disconnect forgets, then revokes.
 */

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { sha256Hex } from "../model/accountSecrets";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const ACCOUNT_SECRET = "bask_test-owner-secret";
const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
const ISSUER = "https://auth.openai.com";

const connectionsTest = (): TestConvex<typeof schema> =>
  convexTest(schema, modules);

type T = TestConvex<typeof schema>;

/** What the stubbed provider answers on the token endpoint. */
interface ProviderAnswer {
  issuer: string;
  audience: string;
  nonce: string;
  scope?: string;
}

let keys: CryptoKeyPair;
let jwk: JsonWebKey & { kid: string };
let provider: ProviderAnswer;
let tokenForms: URLSearchParams[];

beforeEach(async () => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
  keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  jwk = {
    ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
    kid: "key-1",
  };
  provider = {
    issuer: ISSUER,
    audience: "client-issued",
    nonce: "nonce-1",
    scope: "openid offline_access chatgpt.tokens.use.direct",
  };
  tokenForms = [];
  vi.stubGlobal(
    "fetch",
    async (input: string, init?: RequestInit): Promise<Response> => {
      if (input.endsWith("/jwks.json")) return Response.json({ keys: [jwk] });
      if (input.endsWith("/models"))
        return Response.json({
          models: [
            { slug: "gpt-5.5", visibility: "list" },
            { slug: "hidden", visibility: "hide" },
          ],
        });
      tokenForms.push(new URLSearchParams(init?.body as URLSearchParams));

      return Response.json({
        access_token: "access-1",
        refresh_token: "refresh-1",
        id_token: await idToken(),
        expires_in: 3600,
        ...(provider.scope ? { scope: provider.scope } : {}),
      });
    },
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("start answers ChatGPT's consent screen on a registering client", async () => {
  const t = connectionsTest();
  await seedAccount(t);

  const response = await request(t, "POST", "chatgpt/start", startBody());
  const body = await response.json();
  const query = new URL(body.authorizeUrl).searchParams;

  expect(response.status).toBe(200);
  expect(body.hostId).toMatch(/^urn:uuid:/);
  expect(body.clientId).toBe("dynamic_agent_client");
  expect(query.get("client_id")).toBe("dynamic_agent_client");
  expect(query.get("agent_name_hint")).toBe("Broods");
  expect(query.get("ext_agent_host_id")).toBe(body.hostId);
  expect(query.get("resource")).toBe("https://api.openai.com/v1");
  expect(query.get("redirect_uri")).toBe(REDIRECT_URI);
  expect(query.get("code_challenge")).toBe("challenge-1");
  expect(query.get("code_challenge_method")).toBe("S256");
});

test("a redirect off loopback is refused", async () => {
  const t = connectionsTest();
  await seedAccount(t);

  const response = await request(t, "POST", "chatgpt/start", {
    ...startBody(),
    redirectUri: "https://attacker.example/callback",
  });

  expect(response.status).toBe(400);
});

test("a ChatGPT sign-in is stored and reads back without its tokens", async () => {
  const t = connectionsTest();
  const accountId = await seedAccount(t);

  const response = await request(t, "PUT", "chatgpt", codeBody());
  const stored = await response.json();
  const all = await (await request(t, "GET")).json();

  expect(response.status).toBe(200);
  expect(stored).toMatchObject({
    type: "chatgpt",
    clientId: "client-issued",
    hostId: "urn:uuid:host-1",
    email: "user@example.com",
    models: ["gpt-5.5"],
  });
  expect(tokenForms[0]?.get("code_verifier")).toBe("verifier-1");
  expect(tokenForms[0]?.get("client_id")).toBe("client-issued");
  expect(tokenForms[0]?.get("resource")).toBe("https://api.openai.com/v1");
  expect(JSON.stringify(all)).not.toContain("access-1");
  expect(
    await t.query(internal.account.connections.load, {
      accountId: accountId,
      type: "chatgpt",
    }),
  ).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1" });
  const rows = await t.run(async (ctx) =>
    ctx.db.query("connections").collect(),
  );
  expect(JSON.stringify(rows)).not.toContain("refresh-1");
});

test("a sign-in that fails verification or the type's rules stores nothing", async () => {
  const t = connectionsTest();
  await seedAccount(t);

  provider = { ...provider, nonce: "someone-else" };
  const wrongNonce = await request(t, "PUT", "chatgpt", codeBody());
  provider = { ...provider, nonce: "nonce-1", scope: "openid offline_access" };
  const noPlanUsage = await request(t, "PUT", "chatgpt", codeBody());

  expect(wrongNonce.status).toBe(400);
  expect(await wrongNonce.text()).toContain("failed verification");
  expect(noPlanUsage.status).toBe(400);
  expect(await noPlanUsage.text()).toContain("chatgpt.tokens.use.direct");
  expect(await (await request(t, "GET")).json()).toEqual({ connections: [] });
});

test("the managed service refuses ChatGPT before the browser opens", async () => {
  vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
  const t = connectionsTest();
  await seedAccount(t);

  expect((await request(t, "POST", "chatgpt/start", startBody())).status).toBe(
    403,
  );
  expect((await request(t, "PUT", "chatgpt", codeBody())).status).toBe(403);
});

test("a refresh never overwrites a newer sign-in", async () => {
  const t = connectionsTest();
  const accountId = await seedAccount(t);
  await request(t, "PUT", "chatgpt", codeBody());
  const ref = { accountId: accountId, type: "chatgpt" as const };
  const loaded = await t.query(internal.account.connections.load, ref);

  vi.useFakeTimers({ now: loaded!.updatedAt + 1000 });
  await request(t, "PUT", "chatgpt", codeBody());
  vi.useRealTimers();
  const saved = await t.mutation(internal.account.connections.saveRefreshed, {
    ...ref,
    loadedUpdatedAt: loaded!.updatedAt,
    expiresAt: Date.now() + 600_000,
    accessToken: "access-2",
    refreshToken: "refresh-2",
  });

  expect(saved).toBe(false);
  expect(
    (await t.query(internal.account.connections.load, ref))?.accessToken,
  ).toBe("access-1");
});

test("a disconnect forgets the connection, then revokes it", async () => {
  const t = connectionsTest();
  await seedAccount(t);
  await request(t, "PUT", "chatgpt", codeBody());
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
  vi.useFakeTimers();

  const response = await request(t, "DELETE", "chatgpt");
  const scheduled = await t.run(async (ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  expect(await response.json()).toEqual({ deleted: true });
  expect(JSON.stringify(scheduled)).not.toContain("refresh-1");
  expect(revoked).toHaveLength(1);
  expect(revoked[0]?.url).toBe(
    "https://auth.openai.com/api/accounts/oauth/revoke",
  );
  expect(revoked[0]?.form.get("token")).toBe("refresh-1");
  expect((await request(t, "GET", "chatgpt")).status).toBe(404);
});

/** The PUT body `broods connect chatgpt` sends after the redirect. */
function codeBody(): Record<string, string> {
  return {
    code: "code-1",
    codeVerifier: "verifier-1",
    redirectUri: REDIRECT_URI,
    nonce: "nonce-1",
    clientId: "client-issued",
    hostId: "urn:uuid:host-1",
  };
}

/** An ID token for the current provider answer, signed with the test's key. */
async function idToken(): Promise<string> {
  const encode = (binary: string): string =>
    btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const signingInput = `${encode(JSON.stringify({ alg: "RS256", kid: "key-1", typ: "JWT" }))}.${encode(
    JSON.stringify({
      iss: provider.issuer,
      aud: provider.audience,
      exp: Math.floor(Date.now() / 1000) + 600,
      nonce: provider.nonce,
      email: "user@example.com",
    }),
  )}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keys.privateKey,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${encode(String.fromCharCode(...new Uint8Array(signature)))}`;
}

/** One call to the connections routes as the account owner. */
async function request(
  t: T,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path?: string,
  body?: unknown,
): Promise<Response> {
  return await t.fetch(
    `/v1/account/connections${path !== undefined ? `/${path}` : ""}`,
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

/** An org and account whose secret `request` sends. */
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

/** The start body `broods connect` sends before opening the browser. */
function startBody(): Record<string, string> {
  return {
    redirectUri: REDIRECT_URI,
    codeChallenge: "challenge-1",
    state: "state-1",
    nonce: "nonce-1",
  };
}
