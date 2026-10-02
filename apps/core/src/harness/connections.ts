/**
 * A connection's live access token: loaded from the config plane, refreshed
 * before it expires (or once the provider refused it), and the rotated pair
 * saved back. The `chatgpt` model provider dials through `connectionFetch`.
 * `broods connect` signs in; the config plane stores.
 */

import {
  CONNECTION_TYPES,
  type ConnectionType,
} from "@broods/convex/model/connections";
import { toErrorMessage } from "../shared/errors.ts";
import { getStorage, type StoredConnection } from "../shared/storage.ts";
import {
  REFRESH_MARGIN_MS,
  refreshTokenGrant,
  type RefreshedToken,
} from "./mcp/oauth.ts";

/** Re-read the stored connection this often, so a new `broods connect` lands. */
const CACHE_TTL_MS = 5 * 60_000;
/** A stalled refresh fails rather than hold every run waiting on it. */
const REFRESH_TIMEOUT_MS = 15_000;

// Core runs one replica, so an in-flight promise per connection is all the
// serialization a rotating refresh token needs: two runs never spend it twice.
const cache = new Map<string, CachedConnection>();
const inFlight = new Map<string, Promise<StoredConnection>>();
/** The access token a provider refused, so the next load refreshes it. */
const rejected = new Map<string, string>();

interface CachedConnection {
  connection: StoredConnection;
  loadedAt: number;
}

/** The fetch shape the AI SDK dials through. */
type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * A fetch that sends the account's connection token and, when the provider
 * refuses it (401), refreshes once and resends: the AI SDK does not retry
 * a 401.
 */
export function connectionFetch(
  accountId: string,
  type: ConnectionType,
  baseFetch: Fetch,
): Fetch {
  return async (input, init): Promise<Response> => {
    const send = async (token: string): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${token}`);

      return await baseFetch(input, { ...init, headers: headers });
    };
    const token = await accessToken(accountId, type);
    const response = await send(token);
    if (response.status !== 401) return response;
    const key = `${accountId}:${type}`;
    cache.delete(key);
    rejected.set(key, token);

    return await send(await accessToken(accountId, type));
  };
}

/** Forget cached connections; tests only. */
export function resetConnectionsForTests(): void {
  cache.clear();
  inFlight.clear();
  rejected.clear();
}

/** The connection's access token, refreshed when it is close to expiry. */
async function accessToken(
  accountId: string,
  type: ConnectionType,
): Promise<string> {
  const key = `${accountId}:${type}`;
  const cached = cache.get(key);
  if (
    cached &&
    Date.now() - cached.loadedAt < CACHE_TTL_MS &&
    !expiresSoon(cached.connection)
  ) {
    return cached.connection.accessToken;
  }
  // Joined or registered before any await, so concurrent calls share one refresh.
  let pending = inFlight.get(key);
  if (!pending) {
    pending = loadFresh(accountId, type).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }

  return (await pending).accessToken;
}

/** Whether a token is inside the refresh margin, so the next call refreshes it. */
function expiresSoon(connection: StoredConnection): boolean {
  return connection.expiresAt - Date.now() < REFRESH_MARGIN_MS;
}

// Always re-read before refreshing: a new sign-in or another refresh may have
// replaced the token pair since it was cached.
async function loadFresh(
  accountId: string,
  type: ConnectionType,
): Promise<StoredConnection> {
  const key = `${accountId}:${type}`;
  const stored = await getStorage().connections.load(accountId, type);
  if (!stored) {
    cache.delete(key);
    throw new Error(
      `This account has no ${type} connection. Run \`broods connect ${type}\` to sign in.`,
    );
  }
  const connection =
    expiresSoon(stored) || rejected.get(key) === stored.accessToken
      ? await refreshAndSave(accountId, type, stored)
      : stored;
  rejected.delete(key);
  cache.set(key, { connection: connection, loadedAt: Date.now() });

  return connection;
}

/** Refreshes the stored pair at the type's token endpoint and saves it back. */
async function refreshAndSave(
  accountId: string,
  type: ConnectionType,
  stored: StoredConnection,
): Promise<StoredConnection> {
  const meta = CONNECTION_TYPES[type];
  let refreshed: RefreshedToken;
  try {
    refreshed = await refreshTokenGrant(
      meta.tokenUrl,
      {
        client_id: stored.clientId,
        refresh_token: stored.refreshToken,
        // No scope: the refreshed grant keeps what the user approved.
        ...(meta.resource ? { resource: meta.resource } : {}),
      },
      (url, init) =>
        fetch(url, {
          ...init,
          signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
        }),
    );
  } catch (error) {
    // Another writer may have spent this refresh token and saved its pair:
    // storage moved under us, so start over from it.
    const latest = await getStorage().connections.load(accountId, type);
    if (latest && latest.updatedAt !== stored.updatedAt)
      return await loadFresh(accountId, type);
    throw new Error(
      `${meta.label} connection could not refresh: ${toErrorMessage(error)}. Run \`broods connect ${type}\` to sign in again.`,
    );
  }
  // The refresh token rotates; keep the old one only if none came back.
  const rotated = {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? stored.refreshToken,
    expiresAt: refreshed.expiresAt,
  };
  const saved = await getStorage().connections.saveRefreshed(
    accountId,
    type,
    stored,
    rotated,
  );
  // A new sign-in or a disconnect landed while this refresh ran; it wins.
  if (!saved) return await loadFresh(accountId, type);

  return { ...stored, ...rotated, updatedAt: Date.now() };
}
