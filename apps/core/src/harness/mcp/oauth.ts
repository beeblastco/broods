import { cacheDigest } from "../../shared/cache-digest.ts";
import type { McpOauth } from "../../shared/domain/mcp.ts";
import { toErrorMessage } from "../../shared/errors.ts";
import { publicHostFetch } from "../../shared/http.ts";

export const DEFAULT_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

const DEFAULT_EXPIRES_IN_SECONDS = 3600;
const MAX_ERROR_BODY_LENGTH = 512;
const MAX_TOKEN_CACHE_ENTRIES = 256;
export const REFRESH_MARGIN_MS = 60_000;

const tokenCache = new Map<string, Promise<MintedToken>>();

export type ResolvedMcpOauth = Required<McpOauth>;

interface MintedToken {
  accessToken: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

export interface RefreshedToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export function clearMcpOauthTokens(): void {
  tokenCache.clear();
}

// Secrets are identity (a rotated one re-mints) and ride the long-lived key only as a digest.
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

export async function mcpAccessToken(
  serverName: string,
  oauth: ResolvedMcpOauth,
): Promise<string> {
  const key = mcpOauthTokenCacheKey(oauth);
  const pending = tokenCache.get(key);
  if (pending) {
    const minted = await pending.catch(() => null);
    if (minted && minted.expiresAt > Date.now()) return minted.accessToken;
    // Another waiter on the same stale entry may have replaced it already: join that mint.
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
