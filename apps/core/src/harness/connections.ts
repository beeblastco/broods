import {
  CONNECTION_TYPES,
  type ConnectionType,
} from "@broods/convex/model/connections";
import { toErrorMessage } from "../shared/errors.ts";
import { getStorage, type StoredConnection } from "../shared/storage.ts";
import {
  REFRESH_MARGIN_MS,
  tokenGrant,
  type RefreshedToken,
} from "./mcp/oauth.ts";

const CACHE_TTL_MS = 5 * 60_000;
const REFRESH_TIMEOUT_MS = 15_000;

// Core runs one replica, so an in-flight promise per key stops a refresh token being spent twice.
const cache = new Map<string, CachedConnection>();
const inFlight = new Map<string, Promise<StoredTokens>>();
const rejected = new Map<string, string>();

interface CachedConnection {
  connection: StoredTokens;
  loadedAt: number;
}

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  updatedAt: number;
}

export type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Where one credential's tokens live and how they refresh. */
export interface TokenSource<Stored extends StoredTokens> {
  key: string;
  missing: string;
  load(): Promise<Stored | null>;
  refresh(stored: Stored): Promise<RefreshedToken>;
  refreshFailed(message: string): string;
  save(
    stored: Stored,
    rotated: Pick<StoredTokens, "accessToken" | "refreshToken" | "expiresAt">,
  ): Promise<boolean>;
}

export function connectionFetch(
  accountId: string,
  type: ConnectionType,
  baseFetch: Fetch,
): Fetch {
  return tokenFetch(connectionSource(accountId, type), baseFetch);
}

/** On a 401 it refreshes once and resends: neither SDK retries a 401. */
export function tokenFetch<Stored extends StoredTokens>(
  source: TokenSource<Stored>,
  baseFetch: Fetch,
): Fetch {
  return async (input, init): Promise<Response> => {
    const send = async (token: string): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${token}`);

      return await baseFetch(input, { ...init, headers: headers });
    };
    const token = await accessToken(source);
    const response = await send(token);
    if (response.status !== 401) return response;
    cache.delete(source.key);
    rejected.set(source.key, token);

    return await send(await accessToken(source));
  };
}

/** After a new sign-in or a disconnect: the next request loads the stored tokens. */
export function forgetTokens(key: string): void {
  cache.delete(key);
  rejected.delete(key);
}

export function resetConnectionsForTests(): void {
  cache.clear();
  inFlight.clear();
  rejected.clear();
}

async function accessToken<Stored extends StoredTokens>(
  source: TokenSource<Stored>,
): Promise<string> {
  const cached = cache.get(source.key);
  if (
    cached &&
    Date.now() - cached.loadedAt < CACHE_TTL_MS &&
    !expiresSoon(cached.connection)
  ) {
    return cached.connection.accessToken;
  }
  // Joined or registered before any await, so concurrent calls share one refresh.
  let pending = inFlight.get(source.key);
  if (!pending) {
    pending = loadFresh(source).finally(() => inFlight.delete(source.key));
    inFlight.set(source.key, pending);
  }

  return (await pending).accessToken;
}

function connectionSource(
  accountId: string,
  type: ConnectionType,
): TokenSource<StoredConnection> {
  const meta = CONNECTION_TYPES[type];
  const store = getStorage().connections;

  return {
    key: `${accountId}:${type}`,
    missing: `This account has no ${type} connection. Run \`broods connect ${type}\` to sign in.`,
    load: () => store.load(accountId, type),
    refresh: (stored) =>
      tokenGrant(
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
      ),
    refreshFailed: (message) =>
      `${meta.label} connection could not refresh: ${message}. Run \`broods connect ${type}\` to sign in again.`,
    save: (stored, rotated) =>
      store.saveRefreshed(accountId, type, stored, rotated),
  };
}

function expiresSoon(connection: StoredTokens): boolean {
  return connection.expiresAt - Date.now() < REFRESH_MARGIN_MS;
}

async function loadFresh<Stored extends StoredTokens>(
  source: TokenSource<Stored>,
): Promise<StoredTokens> {
  const stored = await source.load();
  if (!stored) {
    cache.delete(source.key);
    throw new Error(source.missing);
  }
  const connection =
    expiresSoon(stored) || rejected.get(source.key) === stored.accessToken
      ? await refreshAndSave(source, stored)
      : stored;
  rejected.delete(source.key);
  cache.set(source.key, { connection: connection, loadedAt: Date.now() });

  return connection;
}

async function refreshAndSave<Stored extends StoredTokens>(
  source: TokenSource<Stored>,
  stored: Stored,
): Promise<StoredTokens> {
  let refreshed: RefreshedToken;
  try {
    refreshed = await source.refresh(stored);
  } catch (error) {
    // Another writer may have spent this refresh token and saved its pair: start over from it.
    const latest = await source.load();
    if (latest && latest.updatedAt !== stored.updatedAt)
      return await loadFresh(source);
    throw new Error(source.refreshFailed(toErrorMessage(error)));
  }
  const rotated = {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? stored.refreshToken,
    expiresAt: refreshed.expiresAt,
  };
  // A new sign-in or a disconnect landed while this refresh ran; it wins.
  if (!(await source.save(stored, rotated))) return await loadFresh(source);

  return { ...stored, ...rotated, updatedAt: Date.now() };
}
