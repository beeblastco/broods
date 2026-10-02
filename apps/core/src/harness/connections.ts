/**
 * A connection's live access token: loaded from the config plane, refreshed
 * before it expires (or once the provider refused it), and the rotated pair
 * saved back. The `chatgpt` model provider and MCP servers with
 * `oauth.connection` dial through `connectionFetch`. `broods connect` signs
 * in; the config plane stores.
 */

import {
  CONNECTION_TYPES,
  connectCommand,
  isConnectionType,
  type ConnectionUse,
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

/** The fetch shape both the AI SDK and the MCP transport dial through. */
type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * A fetch that sends the connection's access token and, when the provider
 * refuses it (401), refreshes once and resends: neither the AI SDK nor the
 * MCP client retries a 401. `use` is who sends it, checked against the type.
 */
export function connectionFetch(
  accountId: string,
  name: string,
  use: ConnectionUse,
  baseFetch: Fetch,
): Fetch {
  return async (input, init): Promise<Response> => {
    const send = async (token: string): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${token}`);

      return await baseFetch(input, { ...init, headers: headers });
    };
    const token = await accessToken(accountId, name, use);
    const response = await send(token);
    if (response.status !== 401) return response;
    const key = `${accountId}:${name}`;
    cache.delete(key);
    rejected.set(key, token);

    return await send(await accessToken(accountId, name, use));
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
  name: string,
  use: ConnectionUse,
): Promise<string> {
  const key = `${accountId}:${name}`;
  const cached = cache.get(key);
  const fresh =
    cached &&
    Date.now() - cached.loadedAt < CACHE_TTL_MS &&
    !expiresSoon(cached.connection);
  let connection: StoredConnection;
  if (fresh) {
    connection = cached.connection;
  } else {
    // Joined or registered before any await, so concurrent calls share one refresh.
    let pending = inFlight.get(key);
    if (!pending) {
      pending = loadFresh(accountId, name).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    connection = await pending;
  }
  const meta = CONNECTION_TYPES[connection.type];
  if (meta.usableBy !== use)
    throw new Error(
      `${name} is a ${meta.label} connection, which ${use === "mcp" ? "MCP servers" : "a model provider"} cannot use.`,
    );

  return connection.accessToken;
}

/** Whether a token is inside the refresh margin, so the next call refreshes it. */
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
      `This account has no ${name} connection. Run \`${connectCommand(isConnectionType(name) ? name : "<type>", name)}\` to sign in.`,
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

/** Refreshes the stored pair at the type's token endpoint and saves it back. */
async function refreshAndSave(
  accountId: string,
  name: string,
  stored: StoredConnection,
): Promise<StoredConnection> {
  const type = CONNECTION_TYPES[stored.type];
  let refreshed: RefreshedToken;
  try {
    refreshed = await refreshTokenGrant(
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
        fetch(url, {
          ...init,
          signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
        }),
    );
  } catch (error) {
    // Another writer may have spent this refresh token and saved its pair:
    // storage moved under us, so start over from it.
    const latest = await getStorage().connections.load(accountId, name);
    if (latest && latest.updatedAt !== stored.updatedAt)
      return await loadFresh(accountId, name);
    throw new Error(
      `${type.label} connection ${name} could not refresh: ${toErrorMessage(error)}. Run \`${connectCommand(stored.type, name)}\` to sign in again.`,
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
    name,
    stored,
    rotated,
  );
  // A new sign-in or a disconnect landed while this refresh ran; it wins.
  if (!saved) return await loadFresh(accountId, name);

  return { ...stored, ...rotated, updatedAt: Date.now() };
}
