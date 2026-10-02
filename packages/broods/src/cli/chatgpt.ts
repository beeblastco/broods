/**
 * `broods login chatgpt`: the browser half of Sign in with ChatGPT. OpenAI only
 * redirects to a loopback address, so the sign-in runs here, on the machine
 * with the browser, and the verified token pair is handed to the deployment,
 * which refreshes it from then on (OpenAI's self-hosted VM flow).
 * https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 */

import { createHash, randomBytes, randomUUID, webcrypto } from "node:crypto";
import {
  CHATGPT_AUTHORIZE_URL,
  CHATGPT_DIRECT_SCOPE,
  CHATGPT_DISCOVERY_URL,
  CHATGPT_DYNAMIC_CLIENT_ID,
  CHATGPT_RESOURCE,
  CHATGPT_SCOPES,
  CHATGPT_TOKEN_URL,
} from "../../../convex/model/chatgpt.ts";
import type { ChatGPTSignIn } from "../account.ts";
import { openBrowser, waitForCallback, waitWithTimeout } from "./utils.ts";

/** The name users see on OpenAI's consent screen and in ChatGPT settings. */
const AGENT_NAME = "Broods";
// OpenAI's documented example port; any port works as long as the scheme,
// host and path stay the same, so a busy one falls back to a free port.
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const SIGN_IN_TIMEOUT =
  "Timed out waiting for the ChatGPT sign-in to finish in the browser.";

/** Who to sign in again, from the deployment's current connection. */
export interface ChatGPTReauthorization {
  clientId: string;
  email?: string;
}

export interface ChatGPTModel {
  slug: string;
  displayName: string;
}

interface AuthorizationCallback {
  code: string;
  clientId: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface IdTokenClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nonce?: string;
  email?: string;
}

interface Jwk extends webcrypto.JsonWebKey {
  kid?: string;
}

/**
 * Opens the browser on OpenAI's consent screen and returns the verified
 * sign-in. `hostId` is the deployment's, so usage is attributed to where the
 * model calls run; a reauthorization reuses the client OpenAI issued before.
 */
export async function signInWithChatGPT(
  hostId: string,
  previous?: ChatGPTReauthorization,
  open: (url: string) => void = openBrowser,
): Promise<ChatGPTSignIn> {
  const state = randomUUID();
  const nonce = randomUUID();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const { code, close } = await waitForCallback(state, {
    port: CALLBACK_PORT,
    fixedPort: false,
    path: CALLBACK_PATH,
    read: readAuthorizationCallback,
    done: "ChatGPT is connected to broods. You can close this tab.",
  });

  try {
    const redirectUri = code.callbackUrl;
    const authorizeUrl = `${CHATGPT_AUTHORIZE_URL}?${new URLSearchParams({
      ...(previous
        ? {
            client_id: previous.clientId,
            ...(previous.email ? { login_hint: previous.email } : {}),
          }
        : {
            client_id: CHATGPT_DYNAMIC_CLIENT_ID,
            agent_name_hint: AGENT_NAME,
          }),
      ext_agent_host_id: hostId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: CHATGPT_SCOPES.join(" "),
      resource: CHATGPT_RESOURCE,
      state: state,
      nonce: nonce,
      code_challenge_method: "S256",
      code_challenge: challenge,
    }).toString()}`;
    open(authorizeUrl);
    console.log(`Opening ${authorizeUrl}`);
    const callback = await waitWithTimeout(
      code.promise,
      undefined,
      SIGN_IN_TIMEOUT,
    );
    const token = await exchangeCode(callback, verifier, redirectUri);
    const claims = await verifyIdToken(
      token.id_token,
      callback.clientId,
      nonce,
    );
    const scopes = token.scope?.split(" ") ?? [];
    if (!scopes.includes(CHATGPT_DIRECT_SCOPE)) {
      throw new Error(
        "Signed in, but ChatGPT plan usage was not allowed. Run `broods login chatgpt` again and allow it, or check that your plan is eligible (ChatGPT Plus or Pro).",
      );
    }

    return {
      clientId: callback.clientId,
      hostId: hostId,
      ...(claims.email ? { email: claims.email } : {}),
      scopes: scopes,
      expiresAt: new Date(
        Date.now() + (token.expires_in ?? 3600) * 1000,
      ).toISOString(),
      accessToken: token.access_token!,
      refreshToken: token.refresh_token!,
    };
  } finally {
    close();
  }
}

/** The models this sign-in may call, for `config.model.modelId`. */
export async function listChatGPTModels(
  accessToken: string,
): Promise<ChatGPTModel[]> {
  const response = await fetch(`${CHATGPT_RESOURCE}/models`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Listing ChatGPT models failed: ${response.status}`);
  }
  const body = (await response.json()) as {
    models?: Array<{
      slug: string;
      display_name?: string;
      visibility?: string;
    }>;
  };

  return (body.models ?? [])
    .filter((model) => model.visibility === "list")
    .map((model) => ({
      slug: model.slug,
      displayName: model.display_name ?? model.slug,
    }));
}

/** A new `ext_agent_host_id`, for a deployment that has never signed in. */
export function newChatGPTHostId(): string {
  return `urn:uuid:${randomUUID()}`;
}

function readAuthorizationCallback(
  params: URLSearchParams,
): AuthorizationCallback {
  const error = params.get("error");
  if (error) {
    throw new Error(
      `ChatGPT sign-in failed: ${params.get("error_description") ?? error}`,
    );
  }
  const code = params.get("code");
  const clientId = params.get("client_id");
  if (!code || !clientId) {
    throw new Error("ChatGPT sign-in callback carried no code or client_id.");
  }

  return { code: code, clientId: clientId };
}

async function exchangeCode(
  callback: AuthorizationCallback,
  verifier: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const response = await fetch(CHATGPT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: callback.clientId,
      code: callback.code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: CHATGPT_RESOURCE,
    }),
  });
  const token = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || !token.access_token || !token.refresh_token) {
    throw new Error(
      `ChatGPT token exchange failed: ${token.error_description ?? token.error ?? response.status}`,
    );
  }

  return token;
}

/**
 * Checks the ID token's RS256 signature against OpenAI's published keys, then
 * its issuer, audience, expiry and nonce, before any token is stored.
 */
async function verifyIdToken(
  idToken: string | undefined,
  clientId: string,
  nonce: string,
): Promise<IdTokenClaims> {
  if (!idToken) throw new Error("ChatGPT sign-in returned no ID token.");
  const [encodedHeader, encodedPayload, encodedSignature] = idToken.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new Error("ChatGPT ID token is malformed.");
  }
  const header = decodeSegment<{ alg?: string; kid?: string }>(encodedHeader);
  const claims = decodeSegment<IdTokenClaims>(encodedPayload);
  if (header.alg !== "RS256") {
    throw new Error(`ChatGPT ID token uses unsupported alg ${header.alg}.`);
  }
  const discovery = (await (await fetch(CHATGPT_DISCOVERY_URL)).json()) as {
    issuer: string;
    jwks_uri: string;
  };
  const { keys } = (await (await fetch(discovery.jwks_uri)).json()) as {
    keys: Jwk[];
  };
  const jwk = keys.find((key) => key.kid === header.kid);
  if (!jwk) throw new Error("ChatGPT ID token is signed with an unknown key.");
  const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const key = await webcrypto.subtle.importKey("jwk", jwk, algorithm, false, [
    "verify",
  ]);
  const signed = await webcrypto.subtle.verify(
    algorithm,
    key,
    Buffer.from(encodedSignature, "base64url"),
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
  );
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    !signed ||
    claims.iss !== discovery.issuer ||
    !audiences.includes(clientId) ||
    (claims.exp ?? 0) * 1000 < Date.now() ||
    claims.nonce !== nonce
  ) {
    throw new Error("ChatGPT ID token failed verification.");
  }

  return claims;
}

function decodeSegment<T>(segment: string): T {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
}
