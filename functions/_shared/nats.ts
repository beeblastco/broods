/**
 * NATS transport for the WebSocket gateway integration.
 *
 * One publish, two read paths. Each response chunk is published ONCE to a
 * conversation-scoped subject via core NATS; the durable `WS_RESPONSES`
 * JetStream stream is bound to that subject and captures the same message. So:
 *   - a connected client reads live via core `subscribe` (lowest latency), and
 *   - a reconnecting / late client replays from the stream via a JetStream
 *     consumer, then resumes live.
 * Core publish stores nothing itself — the stream is the only copy — so this is
 * NOT double storage. Switching read paths is the consuming app's choice; the
 * platform just provides both. See examples/nats-stream.ts.
 *
 * Subject: `v1.<accountId>.<agentId>.ws.response.<token>` where
 * `<token> = base64url(publicConversationKey)` (the conversationKey is not a
 * safe NATS subject token on its own). Ordering cursor: the JetStream message
 * sequence (`JsMsg.seq`) for stream readers, or the envelope `sequence`/`eventId`
 * for core subscribers; dedup a core→stream switch by either.
 *
 * The stream is a TRANSIENT replay buffer, not the source of truth — the final
 * result is persisted in the conversation history. So retention can be short and
 * storage is tunable (see the stream-config constants below).
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
// These are the storage knobs — the stream is a short-lived replay buffer, so
// they can be tuned down (or storage switched to Memory) without losing the
// final result, which lives in the conversation history.
const RESPONSE_STREAM_NAME = "WS_RESPONSES";
const RESPONSE_SUBJECT_WILDCARD = "v1.*.*.ws.response.*";
const RESPONSE_STREAM_STORAGE = StorageType.File; // Memory = faster/cheaper, lost on restart
const NANOS_PER_MS = 1_000_000;
// How long a finished stream stays replayable for a reconnecting client.
const RESPONSE_STREAM_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RESPONSE_STREAM_MAX_MSGS_PER_SUBJECT = 5_000;
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
      try {
        await jsm.streams.info(RESPONSE_STREAM_NAME);
        return;
      } catch {
        // Not found: create it below.
      }
      try {
        await jsm.streams.add({
          name: RESPONSE_STREAM_NAME,
          subjects: [RESPONSE_SUBJECT_WILDCARD],
          retention: RetentionPolicy.Limits,
          storage: RESPONSE_STREAM_STORAGE,
          discard: DiscardPolicy.Old,
          max_age: RESPONSE_STREAM_MAX_AGE_MS * NANOS_PER_MS,
          max_msgs_per_subject: RESPONSE_STREAM_MAX_MSGS_PER_SUBJECT,
          duplicate_window: RESPONSE_STREAM_DUPLICATE_WINDOW_MS * NANOS_PER_MS,
        });
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

// Map a resume cursor to a JetStream consumer start policy: by sequence (last
// JsMsg.seq seen), by time (when a core subscriber dropped), or from the start.
export function consumerStartPolicy(startSequence?: number, startTime?: string) {
  if (typeof startSequence === "number") {
    return { deliver_policy: DeliverPolicy.StartSequence, opt_start_seq: startSequence };
  }
  if (startTime) {
    return { deliver_policy: DeliverPolicy.StartTime, opt_start_time: startTime };
  }
  return { deliver_policy: DeliverPolicy.All };
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
