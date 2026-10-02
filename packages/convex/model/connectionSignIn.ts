/**
 * The provider half of a connection sign-in, run by the config plane:
 * `/v1/account/connections/{type}/start` builds the consent URL and the PUT
 * trades the code the browser brought back for tokens, verifying the ID token
 * before anything is stored. Plain fetch and Web Crypto, so it runs in Convex.
 */

import {
  CHATGPT_AGENT_NAME,
  CHATGPT_DYNAMIC_CLIENT_ID,
  CONNECTION_TYPES,
  type ConnectionStart,
  type ConnectionType,
} from "./connections";

const PROVIDER_TIMEOUT_MS = 10_000;

/** The token endpoint's answer to a code exchange. */
export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  /** Epoch ms. */
  expiresAt: number;
  /** Granted scopes; the requested ones when the provider omits them (RFC 6749 5.1). */
  scopes: string[];
}

/** The ID token claims a connection keeps. */
export interface IdTokenClaims {
  email?: string;
}

/** The OAuth client a sign-in runs on, and ChatGPT's host id. */
export interface SignInClient {
  clientId: string;
  clientSecret?: string;
  hostId?: string;
  /** Who signed in last time, so the consent screen can preselect them. */
  email?: string;
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

interface RawIdTokenClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nonce?: string;
  email?: string;
  /** Microsoft's sign-in name, when the email claim is not configured. */
  preferred_username?: string;
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

/** The consent screen a `broods connect` browser opens. */
export function authorizeUrl(
  type: ConnectionType,
  client: SignInClient,
  start: ConnectionStart,
): string {
  const meta = CONNECTION_TYPES[type];
  const query = new URLSearchParams({
    client_id: client.clientId,
    response_type: "code",
    redirect_uri: start.redirectUri,
    scope: meta.scopes.join(" "),
    state: start.state,
    nonce: start.nonce,
    code_challenge_method: "S256",
    code_challenge: start.codeChallenge,
    ...(client.email ? { login_hint: client.email } : {}),
    ...meta.authorizeParams,
    ...(meta.resource ? { resource: meta.resource } : {}),
    ...(client.clientId === CHATGPT_DYNAMIC_CLIENT_ID
      ? { agent_name_hint: CHATGPT_AGENT_NAME }
      : {}),
    ...(client.hostId ? { ext_agent_host_id: client.hostId } : {}),
  });

  return `${meta.authorizeUrl}?${query.toString()}`;
}

/** Trades the code at the type's token endpoint; both tokens and an ID token must come back. */
export async function exchangeCode(
  type: ConnectionType,
  client: SignInClient,
  code: { code: string; codeVerifier: string; redirectUri: string },
): Promise<IssuedTokens> {
  const meta = CONNECTION_TYPES[type];
  const response = await fetch(meta.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.clientId,
      code: code.code,
      code_verifier: code.codeVerifier,
      redirect_uri: code.redirectUri,
      ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
      ...(meta.resource ? { resource: meta.resource } : {}),
    }),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  const token = (await response.json().catch(() => ({}))) as TokenResponse;
  if (
    !response.ok ||
    !token.access_token ||
    !token.refresh_token ||
    !token.id_token
  ) {
    throw new Error(
      `${meta.label} sign-in failed: ${token.error_description ?? token.error ?? `HTTP ${response.status}`}`,
    );
  }

  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    idToken: token.id_token,
    expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
    scopes: token.scope?.split(" ") ?? [...meta.scopes],
  };
}

/** The model ids a sign-in may call, for types that list them; empty when the list fails. */
export async function listModels(
  type: ConnectionType,
  accessToken: string,
): Promise<string[]> {
  const modelsUrl = CONNECTION_TYPES[type].modelsUrl;
  if (!modelsUrl) return [];
  try {
    const response = await fetch(modelsUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as {
      models?: Array<{ slug: string; visibility?: string }>;
    };

    return (body.models ?? [])
      .filter((model) => model.visibility === "list")
      .map((model) => model.slug);
  } catch {
    return [];
  }
}

/**
 * Checks the ID token's RS256 signature against the provider's published
 * keys, then its issuer, audience, expiry and nonce, before anything is
 * stored.
 */
export async function verifyIdToken(
  type: ConnectionType,
  idToken: string,
  clientId: string,
  nonce: string,
): Promise<IdTokenClaims> {
  const meta = CONNECTION_TYPES[type];
  const [encodedHeader, encodedPayload, encodedSignature] = idToken.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new Error(`${meta.label} ID token is malformed.`);
  }
  const header = decodeSegment<{ alg?: string; kid?: string }>(encodedHeader);
  const claims = decodeSegment<RawIdTokenClaims>(encodedPayload);
  if (header.alg !== "RS256") {
    throw new Error(
      `${meta.label} ID token uses unsupported alg ${header.alg}.`,
    );
  }
  const jwks = await fetch(meta.jwksUrl, {
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  const { keys } = (await jwks.json()) as { keys: Jwk[] };
  const jwk = keys.find((key) => key.kid === header.kid);
  if (!jwk) {
    throw new Error(`${meta.label} ID token is signed with an unknown key.`);
  }
  const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e },
    algorithm,
    false,
    ["verify"],
  );
  const signed = await crypto.subtle.verify(
    algorithm,
    key,
    base64UrlBytes(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    !signed ||
    !meta.issuer.test(claims.iss ?? "") ||
    !audiences.includes(clientId) ||
    typeof claims.exp !== "number" ||
    claims.exp * 1000 < Date.now() ||
    claims.nonce !== nonce
  ) {
    throw new Error(`${meta.label} ID token failed verification.`);
  }
  const email = claims.email ?? claims.preferred_username;

  return email ? { email: email } : {};
}

/** Base64url bytes, as JWT segments and signatures are encoded. */
function base64UrlBytes(segment: string): Uint8Array<ArrayBuffer> {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));

  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** One JWT segment, parsed as JSON. */
function decodeSegment<T>(segment: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlBytes(segment))) as T;
}
