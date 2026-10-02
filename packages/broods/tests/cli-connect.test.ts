/**
 * `broods connect` against stubbed providers: the browser redirect is played
 * by the test, the ID token is signed with a local key, and nothing is handed
 * back unless the token verifies and the type's own rules hold.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { Connection, ConnectionType } from "../src/account.ts";
import { connectInBrowser, type ConnectOptions } from "../src/cli/connect.ts";

const ISSUERS: Record<ConnectionType, string> = {
  chatgpt: "https://auth.openai.com",
  google: "https://accounts.google.com",
  microsoft:
    "https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0",
};
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "key-1" };
const realFetch = globalThis.fetch;
const realLog = console.log;

let tokenForm: URLSearchParams | undefined;
let grantedScope: string | undefined;
let nonceOverride: string | undefined;

beforeEach(() => {
  tokenForm = undefined;
  grantedScope =
    "openid profile email offline_access chatgpt.tokens.use.direct";
  nonceOverride = undefined;
  console.log = (): void => {};
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
});

describe("connectInBrowser", () => {
  it("registers a ChatGPT client for a new deployment", async () => {
    const { signIn, authorize } = await runSignIn("chatgpt");

    expect(authorize.get("client_id")).toBe("dynamic_agent_client");
    expect(authorize.get("agent_name_hint")).toBe("Broods");
    expect(authorize.get("ext_agent_host_id")).toMatch(/^urn:uuid:/);
    expect(authorize.get("resource")).toBe("https://api.openai.com/v1");
    expect(authorize.get("code_challenge_method")).toBe("S256");
    expect(authorize.get("redirect_uri")).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/,
    );
    expect(tokenForm?.get("client_id")).toBe("client-issued");
    expect(tokenForm?.get("code_verifier")).toBeTruthy();
    expect(signIn).toMatchObject({
      type: "chatgpt",
      clientId: "client-issued",
      email: "user@example.com",
      accessToken: "access-1",
      refreshToken: "refresh-1",
    });
  });

  it("reauthorizes ChatGPT on the client and host id it holds", async () => {
    const { authorize } = await runSignIn("chatgpt", {
      name: "chatgpt",
      type: "chatgpt",
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

  it("signs Google in on the developer's own OAuth app", async () => {
    grantedScope = undefined;

    const { signIn, authorize } = await runSignIn("google", null, {
      clientId: "google-client",
      clientSecret: "google-secret",
    });

    expect(authorize.get("client_id")).toBe("google-client");
    expect(authorize.get("access_type")).toBe("offline");
    expect(authorize.get("scope")).toContain("gmail.modify");
    expect(authorize.has("ext_agent_host_id")).toBe(false);
    expect(tokenForm?.get("client_secret")).toBe("google-secret");
    expect(signIn).toMatchObject({
      type: "google",
      clientId: "google-client",
      clientSecret: "google-secret",
    });
    expect(signIn.scopes).toContain(
      "https://www.googleapis.com/auth/gmail.modify",
    );
  });

  it("asks for the OAuth app before opening a browser", async () => {
    const error = await runSignIn("google", null, {
      clientId: "google-client",
    }).catch((caught: unknown) => caught);

    expect(String(error)).toContain("--client-secret");
  });

  it("refuses an ID token minted for another sign-in", async () => {
    nonceOverride = "someone-else";

    const error = await runSignIn("chatgpt").catch((caught: unknown) => caught);

    expect(String(error)).toContain("failed verification");
  });

  it("refuses a ChatGPT sign-in that did not allow plan usage", async () => {
    grantedScope = "openid profile email offline_access";

    const error = await runSignIn("chatgpt").catch((caught: unknown) => caught);

    expect(String(error)).toContain(
      "chatgpt.tokens.use.direct was not granted",
    );
  });
});

/** An ID token signed with the test's key, as a provider would mint it. */
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

/** Plays the provider: answers JWKS and the token endpoint, and redirects the "browser" back. */
async function runSignIn(
  type: ConnectionType,
  current: Connection | null = null,
  options: ConnectOptions = {},
): Promise<{
  signIn: Awaited<ReturnType<typeof connectInBrowser>>;
  authorize: URLSearchParams;
}> {
  let authorize = new URLSearchParams();
  let nonce = "";
  const clientId = type === "chatgpt" ? "client-issued" : options.clientId;
  globalThis.fetch = Object.assign(
    async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
      if (init?.method !== "POST") return Response.json({ keys: [jwk] });
      tokenForm = new URLSearchParams(init.body as URLSearchParams);

      return Response.json({
        access_token: "access-1",
        refresh_token: "refresh-1",
        id_token: idToken({
          iss: ISSUERS[type],
          aud: clientId,
          exp: Math.floor(Date.now() / 1000) + 600,
          nonce: nonceOverride ?? nonce,
          email: "user@example.com",
        }),
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
      ...(type === "chatgpt" ? { client_id: "client-issued" } : {}),
      state: authorize.get("state") ?? "",
    }).toString();
    void realFetch(callback);
  };

  const signIn = await connectInBrowser(type, current, options, open);

  return { signIn: signIn, authorize: authorize };
}
