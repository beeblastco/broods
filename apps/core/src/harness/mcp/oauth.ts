/**
 * OAuth 2.0 refresh-token grant for external MCP servers. Google's official
 * Workspace MCP endpoints only accept short-lived access tokens, so a static
 * Authorization header cannot hold: this module mints an access token per
 * oauth config, caches it in-process, and re-mints with a safety margin
 * before expiry. client.ts stamps the minted token onto the connection's
 * Authorization header at connect time. `refreshTokenGrant` is the grant
 * itself, which `connections.ts` also refreshes every connection with.
 */

import { cacheDigest } from "../../shared/cache-digest.ts";
import type { McpOauth } from "../../shared/domain/mcp.ts";
import { toErrorMessage } from "../../shared/errors.ts";
import { publicHostFetch } from "../../shared/http.ts";

export const DEFAULT_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Google and OpenAI return 3600; a response without expires_in gets the same lease. */
const DEFAULT_EXPIRES_IN_SECONDS = 3600;
const MAX_ERROR_BODY_LENGTH = 512;
const MAX_TOKEN_CACHE_ENTRIES = 256;
/** Re-mint this long before expiry, so a sent token is never on its last seconds. */
export const REFRESH_MARGIN_MS = 60_000;

const tokenCache = new Map<string, Promise<MintedToken>>();

/** Oauth config after the config overlay: every field present, no ${NAME} refs. */
export type ResolvedMcpOauth = Required<McpOauth>;

interface MintedToken {
  accessToken: string;
  expiresAt: number;
}

/** The token endpoint's JSON body, untrusted until checked. */
interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

/** A refresh-token grant's answer. `refreshToken` only when the server rotated it. */
export interface RefreshedToken {
  accessToken: string;
  refreshToken?: string;
  /** The token's real expiry, epoch ms. */
  expiresAt: number;
}

/** Tests only (via setMcpForTests): drop every cached token. */
export function clearMcpOauthTokens(): void {
  tokenCache.clear();
}

/**
 * The token cache identity of one oauth config. Every field is identity, so a
 * rotated secret must not reuse the old token; they ride the key as a
 * process-keyed digest because a Map key lives process-wide for the token's
 * whole lease.
 */
export function mcpOauthTokenCacheKey(oauth: ResolvedMcpOauth): string {
  return cacheDigest(
    JSON.stringify([
      oauth.tokenUrl,
      oauth.clientId,
      oauth.clientSecret,
      oauth.refreshToken,
    ]),
  );
}

/**
 * The access token for one oauth config, minted via grant_type=refresh_token
 * when the cache holds none or the cached one is inside the refresh margin.
 * Concurrent callers, cold or stale, share one in-flight mint; a failed mint is evicted
 * so the next call retries instead of replaying the error for an hour.
 */
export async function mcpAccessToken(
  serverName: string,
  oauth: ResolvedMcpOauth,
): Promise<string> {
  const key = mcpOauthTokenCacheKey(oauth);
  const pending = tokenCache.get(key);
  if (pending) {
    const minted = await pending.catch(() => null);
    if (minted && minted.expiresAt > Date.now()) return minted.accessToken;
    // Another caller that awaited the same stale entry may have replaced it
    // already; join that mint instead of starting a second one.
    if (tokenCache.get(key) !== pending)
      return mcpAccessToken(serverName, oauth);
    tokenCache.delete(key);
  }
  const mint = mintAccessToken(serverName, oauth);
  mint.catch(() => {
    if (tokenCache.get(key) === mint) tokenCache.delete(key);
  });
  while (tokenCache.size >= MAX_TOKEN_CACHE_ENTRIES) {
    const oldest = tokenCache.keys().next().value;
    if (oldest === undefined) break;
    tokenCache.delete(oldest);
  }
  tokenCache.set(key, mint);

  return (await mint).accessToken;
}

/**
 * One form-encoded grant_type=refresh_token POST, shared by MCP oauth and
 * `connections.ts`. Throws the endpoint's reason; callers say who failed.
 */
export async function refreshTokenGrant(
  tokenUrl: string,
  form: Record<string, string>,
  fetchToken: (url: string, init: RequestInit) => Promise<Response>,
): Promise<RefreshedToken> {
  const response = await fetchToken(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      ...form,
    }).toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `status ${response.status} ${text.slice(0, MAX_ERROR_BODY_LENGTH)}`,
    );
  }
  let parsed: TokenResponse;
  try {
    parsed = JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error("token endpoint returned non-JSON");
  }
  if (typeof parsed.access_token !== "string" || parsed.access_token === "") {
    throw new Error("token response carries no access_token");
  }
  const expiresInSeconds =
    typeof parsed.expires_in === "number" && parsed.expires_in > 0
      ? parsed.expires_in
      : DEFAULT_EXPIRES_IN_SECONDS;

  return {
    accessToken: parsed.access_token,
    ...(typeof parsed.refresh_token === "string" && parsed.refresh_token
      ? { refreshToken: parsed.refresh_token }
      : {}),
    expiresAt: Date.now() + expiresInSeconds * 1000,
  };
}

/** One form-encoded POST to the token endpoint; errors name the server. */
async function mintAccessToken(
  serverName: string,
  oauth: ResolvedMcpOauth,
): Promise<MintedToken> {
  try {
    const token = await refreshTokenGrant(
      oauth.tokenUrl,
      {
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        refresh_token: oauth.refreshToken,
      },
      publicHostFetch,
    );

    return {
      accessToken: token.accessToken,
      expiresAt: token.expiresAt - REFRESH_MARGIN_MS,
    };
  } catch (error) {
    throw new Error(
      `MCP server ${serverName}: OAuth token refresh against ${oauth.tokenUrl} failed: ${toErrorMessage(error)}`,
    );
  }
}
