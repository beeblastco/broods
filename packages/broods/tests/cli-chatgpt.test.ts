/**
 * `broods login chatgpt` against a stubbed OpenAI: the browser redirect is
 * played by the test, the ID token is signed with a local key, and nothing is
 * handed back unless the token verifies and plan usage was granted.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { signInWithChatGPT } from "../src/cli/chatgpt.ts";

const ISSUER = "https://auth.openai.com";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "key-1" };
const realFetch = globalThis.fetch;
const realLog = console.log;

let tokenForm: URLSearchParams | undefined;
let grantedScope: string | undefined;
let idTokenClaims: (nonce: string) => Record<string, unknown>;

beforeEach(() => {
  tokenForm = undefined;
  grantedScope =
    "openid profile email offline_access chatgpt.tokens.use.direct";
  idTokenClaims = (nonce) => ({
    iss: ISSUER,
    aud: "client-issued",
    exp: Math.floor(Date.now() / 1000) + 600,
    nonce: nonce,
    email: "user@example.com",
  });
  console.log = () => {};
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
});

describe("signInWithChatGPT", () => {
  it("registers a new client and returns the verified sign-in", async () => {
    const { signIn, authorize } = await runSignIn();

    expect(authorize.get("client_id")).toBe("dynamic_agent_client");
    expect(authorize.get("agent_name_hint")).toBe("Broods");
    expect(authorize.get("ext_agent_host_id")).toMatch(/^urn:uuid:/);
    expect(authorize.get("scope")).toBe(
      "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    );
    expect(authorize.get("resource")).toBe("https://api.openai.com/v1");
    expect(authorize.get("code_challenge_method")).toBe("S256");
    expect(authorize.get("redirect_uri")).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/,
    );
    expect(tokenForm?.get("client_id")).toBe("client-issued");
    expect(tokenForm?.get("code")).toBe("code-1");
    expect(tokenForm?.get("code_verifier")).toBeTruthy();
    expect(signIn).toMatchObject({
      clientId: "client-issued",
      email: "user@example.com",
      accessToken: "access-1",
      refreshToken: "refresh-1",
    });
  });

  it("reauthorizes on the client OpenAI issued before", async () => {
    const { authorize } = await runSignIn({
      connected: true,
      clientId: "client-issued",
      hostId: "urn:uuid:host",
      email: "user@example.com",
      scopes: [],
      expiresAt: "2026-10-02T12:00:00.000Z",
      updatedAt: "2026-10-02T11:00:00.000Z",
    });

    expect(authorize.get("ext_agent_host_id")).toBe("urn:uuid:host");
    expect(authorize.get("client_id")).toBe("client-issued");
    expect(authorize.get("login_hint")).toBe("user@example.com");
    expect(authorize.has("agent_name_hint")).toBe(false);
  });

  it("refuses an ID token minted for another sign-in", async () => {
    idTokenClaims = () => ({
      iss: ISSUER,
      aud: "client-issued",
      exp: Math.floor(Date.now() / 1000) + 600,
      nonce: "someone-else",
    });

    const error = await runSignIn().catch((caught: unknown) => caught);

    expect(String(error)).toContain("failed verification");
  });

  it("reads an omitted scope as the scopes it asked for", async () => {
    grantedScope = undefined;

    const { signIn } = await runSignIn();

    expect(signIn.scopes).toContain("chatgpt.tokens.use.direct");
  });

  it("refuses a sign-in that did not allow plan usage", async () => {
    grantedScope = "openid profile email offline_access";

    const error = await runSignIn().catch((caught: unknown) => caught);

    expect(String(error)).toContain("plan usage was not allowed");
  });
});

/** Plays OpenAI: answers discovery, JWKS and the token endpoint, and redirects the "browser" back. */
async function runSignIn(
  current: Parameters<typeof signInWithChatGPT>[0] = { connected: false },
): Promise<{
  signIn: Awaited<ReturnType<typeof signInWithChatGPT>>;
  authorize: URLSearchParams;
}> {
  let authorize = new URLSearchParams();
  let nonce = "";
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` });
      }
      if (url === `${ISSUER}/jwks`) return Response.json({ keys: [jwk] });
      tokenForm = new URLSearchParams(init?.body as URLSearchParams);

      return Response.json({
        access_token: "access-1",
        refresh_token: "refresh-1",
        id_token: idToken(idTokenClaims(nonce)),
        expires_in: 3600,
        scope: grantedScope,
      });
    },
    { preconnect: realFetch.preconnect },
  );
  const open = (url: string): void => {
    authorize = new URL(url).searchParams;
    nonce = authorize.get("nonce") ?? "";
    const callback = new URL(authorize.get("redirect_uri") ?? "");
    callback.search = new URLSearchParams({
      code: "code-1",
      client_id: "client-issued",
      state: authorize.get("state") ?? "",
    }).toString();
    void realFetch(callback);
  };

  const signIn = await signInWithChatGPT(current, open);

  return { signIn: signIn, authorize: authorize };
}

function idToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({ alg: "RS256", kid: "key-1", typ: "JWT" })}.${encode({ jti: randomUUID(), ...claims })}`;
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(signingInput),
    keys.privateKey,
  );

  return `${signingInput}.${signature.toString("base64url")}`;
}
