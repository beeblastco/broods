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

const CACHE_TTL_MS = 5 * 60_000;
const REFRESH_TIMEOUT_MS = 15_000;

// Core runs one replica, so an in-flight promise per key stops a refresh token being spent twice.
const cache = new Map<string, CachedConnection>();
const inFlight = new Map<string, Promise<StoredConnection>>();
const rejected = new Map<string, string>();

interface CachedConnection {
  connection: StoredConnection;
  loadedAt: number;
}

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** On a 401 it refreshes once and resends: the AI SDK does not retry a 401. */
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

export function resetConnectionsForTests(): void {
  cache.clear();
  inFlight.clear();
  rejected.clear();
}

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

function expiresSoon(connection: StoredConnection): boolean {
  return connection.expiresAt - Date.now() < REFRESH_MARGIN_MS;
}

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
        ...(meta.resource ? { resource: meta.resource } : {}),
      },
      (url, init) =>
        fetch(url, {
          ...init,
          signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
        }),
    );
  } catch (error) {
    // Another writer may have spent this refresh token and saved its pair: start over from it.
    const latest = await getStorage().connections.load(accountId, type);
    if (latest && latest.updatedAt !== stored.updatedAt)
      return await loadFresh(accountId, type);
    throw new Error(
      `${meta.label} connection could not refresh: ${toErrorMessage(error)}. Run \`broods connect ${type}\` to sign in again.`,
    );
  }
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
