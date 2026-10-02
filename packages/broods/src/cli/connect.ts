/**
 * `broods connect <type>`: the browser half of a connection. Providers only
 * redirect to a loopback address, so the sign-in runs here, on the machine
 * with the browser, and the verified token pair is handed to the deployment,
 * which refreshes it from then on. One flow for every type in
 * CONNECTION_TYPES: PKCE, a verified ID token, then the type's own rules.
 */

import { createHash, randomBytes, randomUUID, webcrypto } from "node:crypto";
import {
  CHATGPT_DIRECT_SCOPE,
  CHATGPT_DYNAMIC_CLIENT_ID,
  CHATGPT_RESOURCE,
  CONNECTION_TYPES,
  type Connection,
  type ConnectionSignIn,
  type ConnectionType,
} from "../../../convex/model/connections.ts";
import { openBrowser, waitForCallback, waitWithTimeout } from "./utils.ts";

/** The name users see on OpenAI's consent screen and in ChatGPT settings. */
const AGENT_NAME = "Broods";
// OpenAI's documented example port; any port works as long as the scheme,
// host and path stay the same, so a busy one falls back to a free port.
// Google and Microsoft accept any loopback port for a desktop client.
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";

/** What the developer passes for a type that runs on their own OAuth app. */
export interface ConnectOptions {
  /** Replaces the type's default scopes. */
  scopes?: string[];
  clientId?: string;
  clientSecret?: string;
}

interface ChatGPTModel {
  slug: string;
  displayName: string;
}

interface AuthorizationCallback {
  code: string;
  /** ChatGPT answers with the client it registered; the others echo nothing. */
  clientId: string | undefined;
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

/** A successful code exchange: both tokens are present. */
interface IssuedTokens extends TokenResponse {
  access_token: string;
  refresh_token: string;
}

interface IdTokenClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nonce?: string;
  email?: string;
  /** Microsoft's sign-in name, when the email claim is not configured. */
  preferred_username?: string;
}

interface Jwk extends webcrypto.JsonWebKey {
  kid?: string;
}

/** The OAuth client a sign-in runs on, and ChatGPT's host id. */
interface SignInClient {
  clientId: string;
  clientSecret?: string;
  hostId?: string;
}

/**
 * Opens the browser on the provider's consent screen and returns the
 * verified sign-in. `current` is what the deployment already holds under this
 * name: a ChatGPT reauthorization keeps its host id and issued client, and an
 * own-app type reuses its client id.
 */
export async function connectInBrowser(
  type: ConnectionType,
  current: Connection | null,
  options: ConnectOptions = {},
  open: (url: string) => void = openBrowser,
): Promise<ConnectionSignIn> {
  const meta = CONNECTION_TYPES[type];
  const client = resolveClient(type, current, options);
  const scopes = options.scopes ?? [...meta.defaultScopes];
  const state = randomUUID();
  const nonce = randomUUID();
  const verifier = randomBytes(32).toString("base64url");
  const { code, close } = await waitForCallback(state, {
    port: CALLBACK_PORT,
    fixedPort: false,
    path: CALLBACK_PATH,
    read: readAuthorizationCallback,
    done: `${meta.label} is connected to broods. You can close this tab.`,
  });

  try {
    const redirectUri = code.callbackUrl;
    const query = authorizeQuery(type, client, {
      redirect_uri: redirectUri,
      scope: scopes.join(" "),
      state: state,
      nonce: nonce,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      ...(current?.email ? { login_hint: current.email } : {}),
    });
    const authorizeUrl = `${meta.authorizeUrl}?${query.toString()}`;
    open(authorizeUrl);
    console.log(`Opening ${authorizeUrl}`);
    const callback = await waitWithTimeout(
      code.promise,
      `Timed out waiting for the ${meta.label} sign-in to finish in the browser.`,
    );
    const issued = {
      ...client,
      clientId: callback.clientId ?? client.clientId,
    };
    const token = await exchangeCode(type, {
      grant_type: "authorization_code",
      client_id: issued.clientId,
      code: callback.code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      ...(issued.clientSecret ? { client_secret: issued.clientSecret } : {}),
      ...(issued.hostId ? { resource: CHATGPT_RESOURCE } : {}),
    });
    const claims = await verifyIdToken(
      type,
      token.id_token,
      issued.clientId,
      nonce,
    );

    return signInFrom(type, issued, token, claims, scopes);
  } finally {
    close();
  }
}

/** The models a ChatGPT connection may call, for `config.model.modelId`. */
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

/** The consent screen's query: the shared PKCE fields plus the type's own. */
function authorizeQuery(
  type: ConnectionType,
  client: SignInClient,
  fields: Record<string, string>,
): URLSearchParams {
  const registering = client.clientId === CHATGPT_DYNAMIC_CLIENT_ID;

  return new URLSearchParams({
    client_id: client.clientId,
    response_type: "code",
    code_challenge_method: "S256",
    ...fields,
    ...CONNECTION_TYPES[type].authorizeParams,
    ...(registering ? { agent_name_hint: AGENT_NAME } : {}),
    ...(client.hostId
      ? { ext_agent_host_id: client.hostId, resource: CHATGPT_RESOURCE }
      : {}),
  });
}

function decodeSegment<T>(segment: string): T {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
}

async function exchangeCode(
  type: ConnectionType,
  form: Record<string, string>,
): Promise<IssuedTokens> {
  const meta = CONNECTION_TYPES[type];
  const response = await fetch(meta.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  const token = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || !token.access_token || !token.refresh_token) {
    throw new Error(
      `${meta.label} token exchange failed: ${token.error_description ?? token.error ?? response.status}${token.access_token && !token.refresh_token ? " (no refresh token; check the offline scope)" : ""}`,
    );
  }

  return {
    ...token,
    access_token: token.access_token,
    refresh_token: token.refresh_token,
  };
}

function readAuthorizationCallback(
  params: URLSearchParams,
): AuthorizationCallback {
  const error = params.get("error");
  if (error) {
    throw new Error(
      `Sign-in failed: ${params.get("error_description") ?? error}`,
    );
  }
  const code = params.get("code");
  if (!code) throw new Error("Sign-in callback carried no code.");

  return { code: code, clientId: params.get("client_id") ?? undefined };
}

/**
 * ChatGPT keeps the client OpenAI issued and its host id; the other types run
 * on the developer's own OAuth app, passed once and reused on reconnect.
 */
function resolveClient(
  type: ConnectionType,
  current: Connection | null,
  options: ConnectOptions,
): SignInClient {
  const meta = CONNECTION_TYPES[type];
  if (type === "chatgpt") {
    return {
      clientId: current?.clientId ?? CHATGPT_DYNAMIC_CLIENT_ID,
      hostId: current?.hostId ?? `urn:uuid:${randomUUID()}`,
    };
  }
  const clientId = options.clientId ?? current?.clientId;
  if (!clientId) {
    throw new Error(
      `${meta.label} runs on your own OAuth app: pass --client-id${meta.needsClientSecret ? " and --client-secret" : ""}.`,
    );
  }
  if (meta.needsClientSecret && !options.clientSecret) {
    throw new Error(`${meta.label} needs your OAuth app's --client-secret.`);
  }

  return {
    clientId: clientId,
    ...(options.clientSecret ? { clientSecret: options.clientSecret } : {}),
  };
}

/** The verified sign-in to store, after the type's own grant rules. */
function signInFrom(
  type: ConnectionType,
  client: SignInClient,
  token: IssuedTokens,
  claims: IdTokenClaims,
  requested: string[],
): ConnectionSignIn {
  // No scope in the response means the requested scope was granted (RFC 6749 5.1).
  const scopes = token.scope?.split(" ") ?? requested;
  if (type === "chatgpt" && !scopes.includes(CHATGPT_DIRECT_SCOPE)) {
    throw new Error(
      "Signed in, but ChatGPT plan usage was not allowed. Run `broods connect chatgpt` again and allow it, or check that your plan is eligible (ChatGPT Plus or Pro).",
    );
  }
  const email = claims.email ?? claims.preferred_username;

  return {
    type: type,
    ...client,
    ...(email ? { email: email } : {}),
    scopes: scopes,
    expiresAt: new Date(
      Date.now() + (token.expires_in ?? 3600) * 1000,
    ).toISOString(),
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
  };
}

/**
 * Checks the ID token's RS256 signature against the provider's published
 * keys, then its issuer, audience, expiry and nonce, before any token is
 * stored.
 */
async function verifyIdToken(
  type: ConnectionType,
  idToken: string | undefined,
  clientId: string,
  nonce: string,
): Promise<IdTokenClaims> {
  const meta = CONNECTION_TYPES[type];
  if (!idToken) throw new Error(`${meta.label} sign-in returned no ID token.`);
  const [encodedHeader, encodedPayload, encodedSignature] = idToken.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new Error(`${meta.label} ID token is malformed.`);
  }
  const header = decodeSegment<{ alg?: string; kid?: string }>(encodedHeader);
  const claims = decodeSegment<IdTokenClaims>(encodedPayload);
  if (header.alg !== "RS256") {
    throw new Error(
      `${meta.label} ID token uses unsupported alg ${header.alg}.`,
    );
  }
  const { keys } = (await (await fetch(meta.jwksUrl)).json()) as {
    keys: Jwk[];
  };
  const jwk = keys.find((key) => key.kid === header.kid);
  if (!jwk) {
    throw new Error(`${meta.label} ID token is signed with an unknown key.`);
  }
  const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const key = await webcrypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e },
    algorithm,
    false,
    ["verify"],
  );
  const signed = await webcrypto.subtle.verify(
    algorithm,
    key,
    Buffer.from(encodedSignature, "base64url"),
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
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

  return claims;
}
