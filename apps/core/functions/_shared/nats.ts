/**
 * NATS transport for the WebSocket gateway integration.
 *
 * One publish, two read paths. Each response chunk is published ONCE to a
 * conversation-scoped subject via core NATS; the durable `WS_RESPONSES`
 * JetStream stream is bound to that subject and captures the same message. So:
 *   - a connected client reads live via core `subscribe` (lowest latency), and
 *   - a client that dropped mid-stream reconnects and RESUMES the still-streaming
 *     turn from the JetStream consumer, then continues live.
 * Core publish stores nothing itself — the stream is the only copy — so this is
 * NOT double storage. Switching read paths is the consuming app's choice; the
 * platform just provides both.
 *
 * Subject: `v1.<accountId>.<agentId>.ws.response.<token>` where
 * `<token> = base64url(publicConversationKey)` (the conversationKey is not a
 * safe NATS subject token on its own). Ordering cursor: the JetStream message
 * sequence (`JsMsg.seq`) for stream readers, or the envelope `sequence`/`eventId`
 * for core subscribers; dedup a core→stream switch by either.
 *
 * The stream is a RESUME buffer for an in-flight turn, not the source of truth —
 * the conversation history DB is. JetStream exists only so a client that drops
 * mid-stream can reconnect and resume a still-streaming turn. So it holds as
 * little as possible: as soon as a turn finishes and is persisted to the DB, the
 * server purges that conversation from the stream ({@link LiveNatsPublisher.purge}) —
 * a later reconnect reads the finished turn from the DB, so replay would be
 * pointless. A short `max_age` only backstops turns that never persist cleanly
 * (e.g. an error/crash before the server purges).
 *
 * Transport is selected by the `NATS_URL` scheme via {@link connectNats}:
 *   - `wss://` / `ws://` -> WebSocket (`nats.ws`), for out-of-cluster callers
 *     like this Lambda (the cluster exposes only a `wss://` ingress externally).
 *   - `nats://` / `tls://` -> core TCP (`nats`), for in-cluster callers on the
 *     internal network (lower latency; core 4222 isn't exposed externally).
 * Moving a service in-cluster is then just a `NATS_URL` change, not a code change.
 * Pass a token for token-auth servers.
 */

import {
  connect as connectWebSocket,
  headers as natsHeaders,
  DeliverPolicy,
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  type ConsumerMessages,
  type NatsConnection,
  type Subscription,
} from "nats.ws";
import { connect as connectTcp } from "nats";

export type { NatsConnection };

export interface NatsPublisher {
  publish(data: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

export interface NatsEventHeaders {
  accountId: string;
  agentId: string;
  conversationKey: string;
  eventId: string;
  // Label only: identifies the originating socket. The subject is keyed on the
  // conversation, so a reconnecting client uses a new connectionId but the same
  // stream.
  connectionId: string;
}

export interface NatsStreamEvent {
  type: "stream";
  headers: NatsEventHeaders;
  data: Record<string, unknown>;
  sequence: number;
}

// One stream covers every conversation; per-subject retention bounds growth.
// These are the storage knobs. The stream is ONLY an in-flight resume buffer —
// the conversation history DB is the source of truth — so the server purges a
// conversation as soon as its turn is persisted (see LiveNatsPublisher.purge).
// max_age is just the backstop for turns that never persist cleanly; they expire
// quickly instead of piling up, since the final result is already in the DB.
const RESPONSE_STREAM_NAME = "WS_RESPONSES";
const RESPONSE_SUBJECT_WILDCARD = "v1.*.*.ws.response.*";
const RESPONSE_STREAM_STORAGE = StorageType.File; // Memory = faster/cheaper, lost on restart
const NANOS_PER_MS = 1_000_000;
// Backstop window only: purge-on-persist clears finished turns, so this just
// caps the buffer for turns that never persist cleanly. Kept very short (3 min).
const RESPONSE_STREAM_MAX_AGE_MS = 3 * 60 * 1000;
const RESPONSE_STREAM_MAX_MSGS_PER_SUBJECT = 2_000;
// Dedup window for Nats-Msg-Id-tagged publishes (retries within it collapse).
const RESPONSE_STREAM_DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

// Shared so token publishing does not allocate an encoder per chunk.
const ENCODER = new TextEncoder();

/**
 * Connect to NATS, picking the transport from the URL scheme: `wss://`/`ws://`
 * use the WebSocket client (out-of-cluster callers like Lambda), anything else
 * (`nats://`/`tls://`) uses the core TCP client (in-cluster callers, lower
 * latency). Both ship the same base client + JetStream API, so the returned
 * connection is interchangeable for every helper here. Pass `token` for
 * token-auth servers.
 */
export async function connectNats(options: {
  servers: string;
  token?: string;
  timeout?: number;
}): Promise<NatsConnection> {
  const connectOptions = { servers: options.servers, token: options.token, timeout: options.timeout ?? 5000 };
  const useWebSocket = /^wss?:\/\//i.test(options.servers);
  const connection = useWebSocket ? await connectWebSocket(connectOptions) : await connectTcp(connectOptions);
  return connection as unknown as NatsConnection;
}

export class LiveNatsPublisher implements NatsPublisher {
  private connectionPromise: Promise<NatsConnection> | null = null;
  private streamReady: Promise<void> | null = null;
  private readonly subject: string;
  private sequence = 0;

  constructor(
    private readonly url: string,
    private readonly headers: NatsEventHeaders,
    // Token-auth credential; omit for an unauthenticated server.
    private readonly token?: string,
  ) {
    this.subject = streamResponseSubject(headers.accountId, headers.agentId, headers.conversationKey);
  }

  private async getConnection(): Promise<NatsConnection> {
    if (!this.connectionPromise) {
      this.connectionPromise = connectNats({ servers: this.url, token: this.token }).catch((err) => {
        this.connectionPromise = null;
        throw err;
      });
    }
    return this.connectionPromise;
  }

  async publish(data: Record<string, unknown>): Promise<void> {
    try {
      const connection = await this.getConnection();
      // Ensure the stream exists before the first publish so it captures from the
      // first token; memoized, so later tokens skip straight to publishing.
      if (!this.streamReady) {
        this.streamReady = ensureResponseStream(connection);
      }
      await this.streamReady;

      this.sequence++;
      const event = {
        type: "stream",
        headers: this.headers,
        data,
        sequence: this.sequence,
      };
      // Core publish: fire-and-forget at core-NATS speed for live subscribers,
      // while the bound stream captures the same message for replay. Nats-Msg-Id
      // makes it idempotent within the stream's duplicate_window so a retry never
      // stores a duplicate.
      const hdrs = natsHeaders();
      hdrs.set("Nats-Msg-Id", `${this.headers.eventId}:${this.sequence}`);
      connection.publish(this.subject, ENCODER.encode(JSON.stringify(event)), { headers: hdrs });
    } catch {
      // Publishing is best-effort per event; close() drains queued writes.
    }
  }

  /**
   * Drop this conversation's buffered messages from the stream. Call this once
   * the turn is finished and persisted to the conversation DB: the stream is only
   * an in-flight resume buffer, so a finished+saved turn has no reason to stay —
   * a later reconnect reads it from the DB. Best-effort; max_age backstops it.
   */
  async purge(): Promise<void> {
    try {
      const connection = await this.getConnection();
      const jsm = await connection.jetstreamManager();
      await jsm.streams.purge(RESPONSE_STREAM_NAME, { filter: this.subject });
    } catch {
      // Best-effort: a failed purge just leaves the buffer to expire via max_age.
    }
  }

  async close(): Promise<void> {
    if (this.connectionPromise) {
      try {
        const connection = await this.connectionPromise;
        // Drain flushes pending publishes to the server (where the stream stores
        // them) before closing. It does not affect other concurrent invocations.
        await connection.drain();
      } catch {
        // Ignore drain errors.
      }
    }
  }
}

// Create the response stream once per process; idempotent across concurrent
// invocations (a racing creator just sees "stream already exists").
let ensureStreamPromise: Promise<void> | undefined;

export async function ensureResponseStream(connection: NatsConnection): Promise<void> {
  if (!ensureStreamPromise) {
    ensureStreamPromise = (async () => {
      const jsm = await connection.jetstreamManager();
      // retention/storage/name are immutable after creation; the retention knobs
      // (max_age, max_msgs_per_subject, duplicate_window) are mutable, so apply
      // them on update too — that's how a shortened buffer reaches an existing
      // stream without a destructive recreate.
      const config = {
        name: RESPONSE_STREAM_NAME,
        subjects: [RESPONSE_SUBJECT_WILDCARD],
        retention: RetentionPolicy.Limits,
        storage: RESPONSE_STREAM_STORAGE,
        discard: DiscardPolicy.Old,
        max_age: RESPONSE_STREAM_MAX_AGE_MS * NANOS_PER_MS,
        max_msgs_per_subject: RESPONSE_STREAM_MAX_MSGS_PER_SUBJECT,
        duplicate_window: RESPONSE_STREAM_DUPLICATE_WINDOW_MS * NANOS_PER_MS,
      };
      try {
        await jsm.streams.info(RESPONSE_STREAM_NAME);
        // Exists: best-effort sync of the mutable retention knobs.
        await jsm.streams.update(RESPONSE_STREAM_NAME, config).catch(() => {});
        return;
      } catch {
        // Not found: create it below.
      }
      try {
        await jsm.streams.add(config);
      } catch (err) {
        // A concurrent creator won the race; treat an existing stream as success.
        if (!/already in use|already exists/i.test(err instanceof Error ? err.message : String(err))) {
          throw err;
        }
      }
    })().catch((err) => {
      ensureStreamPromise = undefined;
      throw err;
    });
  }
  return ensureStreamPromise;
}

/**
 * Live read path: a core subscription to a conversation's response subject —
 * lowest latency, for a connected client. Returns an async-iterable of `Msg`;
 * decode `msg.data` as a {@link NatsStreamEvent}. No replay — use
 * {@link readConversationStream} to catch up after a disconnect.
 */
export function subscribeConversationLive(options: {
  connection: NatsConnection;
  accountId: string;
  agentId: string;
  conversationKey: string;
}): Subscription {
  return options.connection.subscribe(
    streamResponseSubject(options.accountId, options.agentId, options.conversationKey),
  );
}

/**
 * Replay read path: a JetStream consumer over a conversation's stored stream.
 * `startSequence` resumes from a known `JsMsg.seq`; `startTime` resumes from an
 * ISO timestamp (useful when switching over from a core subscription, which
 * doesn't see `seq`); neither replays from the start. Returns an async-iterable
 * of JsMsg; decode `msg.data` as a {@link NatsStreamEvent}.
 */
export async function readConversationStream(options: {
  connection: NatsConnection;
  accountId: string;
  agentId: string;
  conversationKey: string;
  startSequence?: number;
  startTime?: string;
}): Promise<ConsumerMessages> {
  await ensureResponseStream(options.connection);
  const js = options.connection.jetstream();
  const subject = streamResponseSubject(options.accountId, options.agentId, options.conversationKey);
  const consumer = await js.consumers.get(RESPONSE_STREAM_NAME, {
    filterSubjects: subject,
    ...consumerStartPolicy(options.startSequence, options.startTime),
  });
  return consumer.consume();
}

/**
 * How many messages are currently buffered for a conversation. 0 means the
 * server has purged it (the turn finished and was persisted) — a reconnecting
 * client should then read the finished turn from the conversation DB, not resume.
 */
export async function conversationBufferedCount(options: {
  connection: NatsConnection;
  accountId: string;
  agentId: string;
  conversationKey: string;
}): Promise<number> {
  try {
    const jsm = await options.connection.jetstreamManager();
    const subject = streamResponseSubject(options.accountId, options.agentId, options.conversationKey);
    const info = await jsm.streams.info(RESPONSE_STREAM_NAME, { subjects_filter: subject });
    return (info.state.subjects as Record<string, number> | undefined)?.[subject] ?? 0;
  } catch {
    return 0;
  }
}

// Map a resume cursor to a JetStream consumer start policy: by sequence (last
// JsMsg.seq seen), by time (when a core subscriber dropped), or from the start.
// From-start returns no policy on purpose: an ordered consumer already defaults
// to all-from-start, and passing an explicit `deliver_policy: All` stalls it
// (delivers nothing) — only the explicit start cursors are safe to set.
export function consumerStartPolicy(startSequence?: number, startTime?: string) {
  if (typeof startSequence === "number") {
    return { deliver_policy: DeliverPolicy.StartSequence, opt_start_seq: startSequence };
  }
  if (startTime) {
    return { deliver_policy: DeliverPolicy.StartTime, opt_start_time: startTime };
  }
  return {};
}

export function streamResponseSubject(accountId: string, agentId: string, conversationKey: string): string {
  return `v1.${accountId}.${agentId}.ws.response.${subjectToken(conversationKey)}`;
}

// Encode an arbitrary conversationKey into a single NATS-safe subject token.
// base64url avoids the reserved `.`, `*`, `>`, and whitespace characters; a
// client recomputes the same token from its conversationKey.
export function subjectToken(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
