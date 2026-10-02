/**
 * A connection's live access token: loaded from the config plane, refreshed
 * before it expires (or once the provider refused it), and the rotated pair
 * saved back. The `chatgpt` model provider and MCP servers with
 * `oauth.connection` call `connectionAccessToken`; the model provider also
 * calls `rejectConnectionToken` on a 401. `broods connect` signs in; the
 * config plane stores.
 */

import {
  CONNECTION_TYPES,
  isConnectionType,
} from "@broods/convex/model/connections";
import { getStorage, type StoredConnection } from "../shared/storage.ts";
import { REFRESH_MARGIN_MS, refreshTokenGrant } from "./mcp/oauth.ts";

/** Re-read the stored connection this often, so a new `broods connect` lands. */
const CACHE_TTL_MS = 5 * 60_000;
/** A stalled refresh fails rather than hold every run waiting on it. */
const REFRESH_TIMEOUT_MS = 15_000;

interface CachedConnection {
  connection: StoredConnection;
  loadedAt: number;
}

// Core runs one replica, so an in-flight promise per connection is all the
// serialization a rotating refresh token needs: two runs never spend it twice.
const cache = new Map<string, CachedConnection>();
const inFlight = new Map<string, Promise<StoredConnection>>();
/** The access token a provider refused, so the next load refreshes it. */
const rejected = new Map<string, string>();

/** The connection's access token, refreshed when it is close to expiry. */
export async function connectionAccessToken(
  accountId: string,
  name: string,
): Promise<string> {
  const key = `${accountId}:${name}`;
  const cached = cache.get(key);
  if (
    cached &&
    Date.now() - cached.loadedAt < CACHE_TTL_MS &&
    !expiresSoon(cached.connection)
  ) {
    return cached.connection.accessToken;
  }
  const pending = inFlight.get(key);
  if (pending) return (await pending).accessToken;

  const next = loadFresh(accountId, name).finally(() => inFlight.delete(key));
  inFlight.set(key, next);

  return (await next).accessToken;
}

/** The provider answered 401 to this token: refresh before the next call. */
export function rejectConnectionToken(
  accountId: string,
  name: string,
  accessToken: string,
): void {
  const key = `${accountId}:${name}`;
  cache.delete(key);
  rejected.set(key, accessToken);
}

/** Forget cached connections; tests only. */
export function resetConnectionsForTests(): void {
  cache.clear();
  inFlight.clear();
  rejected.clear();
}

/** The command that signs this connection in again. */
function connectCommand(
  name: string,
  type: string = isConnectionType(name) ? name : "<type>",
): string {
  return name === type
    ? `broods connect ${type}`
    : `broods connect ${type} --name ${name}`;
}

function expiresSoon(connection: StoredConnection): boolean {
  return connection.expiresAt - Date.now() < REFRESH_MARGIN_MS;
}

// Always re-read before refreshing: a new sign-in or another refresh may have
// replaced the token pair since it was cached.
async function loadFresh(
  accountId: string,
  name: string,
): Promise<StoredConnection> {
  const key = `${accountId}:${name}`;
  const stored = await getStorage().connections.load(accountId, name);
  if (!stored) {
    cache.delete(key);
    throw new Error(
      `This account has no ${name} connection. Run \`${connectCommand(name)}\` to sign in.`,
    );
  }
  const connection =
    expiresSoon(stored) || rejected.get(key) === stored.accessToken
      ? await refreshAndSave(accountId, name, stored)
      : stored;
  rejected.delete(key);
  cache.set(key, { connection: connection, loadedAt: Date.now() });

  return connection;
}

async function refreshAndSave(
  accountId: string,
  name: string,
  stored: StoredConnection,
): Promise<StoredConnection> {
  const type = CONNECTION_TYPES[stored.type];
  const refreshed = await refreshTokenGrant(
    type.tokenUrl,
    {
      client_id: stored.clientId,
      refresh_token: stored.refreshToken,
      ...(stored.clientSecret ? { client_secret: stored.clientSecret } : {}),
      ...(type.resource ? { resource: type.resource } : {}),
      // Otherwise no scope: the refreshed grant keeps what the user approved.
      ...(type.refreshScopes ? { scope: stored.scopes.join(" ") } : {}),
    },
    (url, init) =>
      fetch(url, { ...init, signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) }),
  ).catch((error: unknown) => {
    throw new Error(
      `${type.label} connection ${name} could not refresh: ${error instanceof Error ? error.message : String(error)}. Run \`${connectCommand(name, stored.type)}\` to sign in again.`,
    );
  });
  // The refresh token rotates; keep the old one only if none came back.
  const rotated = {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? stored.refreshToken,
    expiresAt: refreshed.expiresAt,
  };
  const saved = await getStorage().connections.saveRefreshed(
    accountId,
    name,
    stored,
    rotated,
  );
  // A new sign-in or a disconnect landed while this refresh ran; it wins.
  if (!saved) return await loadFresh(accountId, name);

  return { ...stored, ...rotated, updatedAt: Date.now() };
}
