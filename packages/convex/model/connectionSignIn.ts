import {
  CHATGPT_AGENT_NAME,
  CHATGPT_DYNAMIC_CLIENT_ID,
  CONNECTION_TYPES,
  type ConnectionStart,
  type ConnectionType,
} from "./connections";

import { ClientError } from "./clientError";

const PROVIDER_TIMEOUT_MS = 10_000;

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  /** Epoch ms. */
  expiresAt: number;
  scopes: string[];
}

export interface IdTokenClaims {
  email?: string;
}

export interface SignInClient {
  clientId: string;
  hostId: string;
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
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

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
    ...(meta.resource ? { resource: meta.resource } : {}),
    ...(client.clientId === CHATGPT_DYNAMIC_CLIENT_ID
      ? { agent_name_hint: CHATGPT_AGENT_NAME }
      : {}),
    ext_agent_host_id: client.hostId,
  });

  return `${meta.authorizeUrl}?${query.toString()}`;
}

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
    throw new ClientError(
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

export async function verifyIdToken(
  type: ConnectionType,
  idToken: string,
  clientId: string,
  nonce: string,
): Promise<IdTokenClaims> {
  const meta = CONNECTION_TYPES[type];
  const [encodedHeader, encodedPayload, encodedSignature] = idToken.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new ClientError(`${meta.label} ID token is malformed.`);
  }
  const header = decodeSegment<{ alg?: string; kid?: string }>(encodedHeader);
  const claims = decodeSegment<RawIdTokenClaims>(encodedPayload);
  if (header.alg !== "RS256") {
    throw new ClientError(
      `${meta.label} ID token uses unsupported alg ${header.alg}.`,
    );
  }
  const jwks = await fetch(meta.jwksUrl, {
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  const { keys } = (await jwks.json()) as { keys: Jwk[] };
  // Only an RSA signing key for RS256 may verify, whatever else shares its kid.
  const jwk = keys.find(
    (key) =>
      key.kid === header.kid &&
      key.kty === "RSA" &&
      (key.use === undefined || key.use === "sig") &&
      (key.alg === undefined || key.alg === "RS256"),
  );
  if (!jwk) {
    throw new ClientError(
      `${meta.label} ID token is signed with an unknown key.`,
    );
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
    claims.iss !== meta.issuer ||
    !audiences.includes(clientId) ||
    typeof claims.exp !== "number" ||
    claims.exp * 1000 < Date.now() ||
    claims.nonce !== nonce
  ) {
    throw new ClientError(`${meta.label} ID token failed verification.`);
  }

  return claims.email ? { email: claims.email } : {};
}

function base64UrlBytes(segment: string): Uint8Array<ArrayBuffer> {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));

  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeSegment<T>(segment: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlBytes(segment))) as T;
}
