/**
 * OAuth 2.0 refresh-token grant for external MCP servers. Google's official
 * Workspace MCP endpoints only accept short-lived access tokens, so a static
 * Authorization header cannot hold: this module mints an access token per
 * oauth config, caches it in-process, and re-mints with a safety margin
 * before expiry. client.ts stamps the minted token onto the connection's
 * Authorization header at connect time.
 */

import type { McpOauth } from "../../shared/domain/mcp.ts";

export const DEFAULT_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Google returns 3600; a response without expires_in gets the same lease. */
const DEFAULT_EXPIRES_IN_SECONDS = 3600;
const MAX_ERROR_BODY_LENGTH = 512;
const MAX_TOKEN_CACHE_ENTRIES = 256;
/** Re-mint this long before expiry, so a sent token is never on its last seconds. */
const REFRESH_MARGIN_MS = 60_000;

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
  expires_in?: unknown;
}

/** Tests only (via setMcpForTests): drop every cached token. */
export function clearMcpOauthTokens(): void {
  tokenCache.clear();
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
  // Every field is identity: a rotated secret must not reuse the old token.
  const key = JSON.stringify([
    oauth.tokenUrl,
    oauth.clientId,
    oauth.clientSecret,
    oauth.refreshToken,
  ]);
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

/** One form-encoded POST to the token endpoint; errors name the server. */
async function mintAccessToken(
  serverName: string,
  oauth: ResolvedMcpOauth,
): Promise<MintedToken> {
  const failure = (detail: string): Error =>
    new Error(
      `MCP server ${serverName}: OAuth token refresh against ${oauth.tokenUrl} failed: ${detail}`,
    );
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret,
    refresh_token: oauth.refreshToken,
  });
  let response: Response;
  try {
    response = await fetch(oauth.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      // The body carries the client secret; never follow it to another host.
      redirect: "error",
    });
  } catch (error) {
    throw failure(error instanceof Error ? error.message : String(error));
  }
  const text = await response.text();
  if (!response.ok) {
    throw failure(
      `status ${response.status} ${text.slice(0, MAX_ERROR_BODY_LENGTH)}`,
    );
  }
  let parsed: TokenResponse;
  try {
    parsed = JSON.parse(text) as TokenResponse;
  } catch {
    throw failure("token endpoint returned non-JSON");
  }
  if (typeof parsed.access_token !== "string" || parsed.access_token === "") {
    throw failure("token response carries no access_token");
  }
  const expiresInSeconds =
    typeof parsed.expires_in === "number" && parsed.expires_in > 0
      ? parsed.expires_in
      : DEFAULT_EXPIRES_IN_SECONDS;

  return {
    accessToken: parsed.access_token,
    expiresAt: Date.now() + expiresInSeconds * 1000 - REFRESH_MARGIN_MS,
  };
}
