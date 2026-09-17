/**
 * The slice of the Matrix client-server API this process touches, over plain
 * fetch. Deliberately narrow, like `discord.ts` in the Discord forwarder: core
 * parses message content, so events here carry only what routing and crypto
 * read and pass the rest through untouched.
 */

const API_PREFIX = "/_matrix/client/v3";
/** Deadline for every call except `/sync`, which sets its own. */
const REQUEST_TIMEOUT_MS = 30_000;
/** How long past the long-poll timeout a sync may hang before it is aborted. */
const SYNC_GRACE_MS = 15_000;
const TYPING_TIMEOUT_MS = 30_000;

/** A timeline event as `/sync` serves it, encrypted or not. */
export interface RoomEvent {
  content: Record<string, unknown>;
  event_id: string;
  origin_server_ts: number;
  sender: string;
  type: string;
}

export interface SyncFilter {
  account_data: { types: string[] };
  presence: { types: string[] };
  room: {
    account_data: { types: string[] };
    ephemeral: { types: string[] };
    state: { types: string[] };
    timeline: { limit: number; types: string[] };
  };
}

export interface SyncOptions {
  filter: SyncFilter;
  signal: AbortSignal;
  since: string | undefined;
  timeoutMs: number;
}

export interface SyncResponse {
  device_lists?: { changed?: string[]; left?: string[] };
  device_one_time_keys_count?: Record<string, number>;
  device_unused_fallback_key_types?: string[];
  next_batch: string;
  rooms?: {
    join?: Record<
      string,
      { timeline?: { events: RoomEvent[]; limited?: boolean } }
    >;
  };
  to_device?: { events: unknown[] };
}

export interface WhoAmI {
  /** Absent for application-service tokens. */
  device_id?: string;
  user_id: string;
}

export class MatrixError extends Error {
  readonly errcode: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly status: number;

  constructor(
    status: number,
    errcode: string | undefined,
    retryAfterMs: number | undefined,
    message: string,
  ) {
    super(message);
    this.errcode = errcode;
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }
}

/** One account's view of its homeserver. Holds no sync state. */
export class MatrixClient {
  private readonly accessToken: string;
  private readonly apiUrl: string;

  constructor(apiUrl: string, accessToken: string) {
    this.accessToken = accessToken;
    this.apiUrl = apiUrl.replace(/\/+$/, "");
  }

  /** User id to display name for everyone joined; no display name maps to undefined. */
  async joinedMembers(
    roomId: string,
  ): Promise<Map<string, string | undefined>> {
    const response = await this.request<{
      joined: Record<string, { display_name?: string | null }>;
    }>("GET", `/rooms/${encodeURIComponent(roomId)}/joined_members`);
    const members = new Map<string, string | undefined>();
    for (const [userId, member] of Object.entries(response.joined)) {
      members.set(userId, member.display_name ?? undefined);
    }

    return members;
  }

  /** JSON string in, JSON string out: the crypto machine hands over raw bodies. */
  async rawRequest(
    method: string,
    path: string,
    body: string,
  ): Promise<string> {
    return this.call(
      method,
      path,
      body,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    );
  }

  async roomEncrypted(roomId: string): Promise<boolean> {
    try {
      await this.request(
        "GET",
        `/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption/`,
      );
    } catch (error) {
      if (error instanceof MatrixError && error.status === 404) return false;
      throw error;
    }

    return true;
  }

  /** Returns the new event id. */
  async sendEvent(
    roomId: string,
    type: string,
    content: Record<string, unknown>,
  ): Promise<string> {
    const response = await this.request<{ event_id: string }>(
      "PUT",
      `/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(type)}/${crypto.randomUUID()}`,
      content,
    );

    return response.event_id;
  }

  async setTyping(
    roomId: string,
    userId: string,
    typing: boolean,
  ): Promise<void> {
    await this.request(
      "PUT",
      `/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(userId)}`,
      typing ? { timeout: TYPING_TIMEOUT_MS, typing: true } : { typing: false },
    );
  }

  async sync(options: SyncOptions): Promise<SyncResponse> {
    const query = new URLSearchParams({
      filter: JSON.stringify(options.filter),
      timeout: String(options.timeoutMs),
    });
    if (options.since !== undefined) query.set("since", options.since);
    const signal = AbortSignal.any([
      options.signal,
      AbortSignal.timeout(options.timeoutMs + SYNC_GRACE_MS),
    ]);

    return this.request<SyncResponse>(
      "GET",
      `/sync?${query.toString()}`,
      undefined,
      signal,
    );
  }

  async whoami(): Promise<WhoAmI> {
    return this.request<WhoAmI>("GET", "/account/whoami");
  }

  private async call(
    method: string,
    path: string,
    body: string | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    const response = await fetch(`${this.apiUrl}${API_PREFIX}${path}`, {
      body: body,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      method: method,
      signal: signal,
    });
    const text = await response.text();
    if (!response.ok) throw toMatrixError(response.status, text);

    return text;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: object,
    signal: AbortSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  ): Promise<T> {
    const text = await this.call(
      method,
      path,
      body === undefined ? undefined : JSON.stringify(body),
      signal,
    );

    return JSON.parse(text) as T;
  }
}

function toMatrixError(status: number, text: string): MatrixError {
  let fields: { errcode?: unknown; error?: unknown; retry_after_ms?: unknown } =
    {};
  try {
    fields = JSON.parse(text);
  } catch {
    // Proxies answer 502s with HTML. The status alone has to do.
  }
  const errcode =
    typeof fields.errcode === "string" ? fields.errcode : undefined;
  const retryAfterMs =
    typeof fields.retry_after_ms === "number"
      ? fields.retry_after_ms
      : undefined;
  const error =
    typeof fields.error === "string" ? fields.error : `HTTP ${status}`;

  return new MatrixError(
    status,
    errcode,
    retryAfterMs,
    `${errcode ?? "M_UNKNOWN"}: ${error}`,
  );
}
