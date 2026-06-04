/**
 * NATS JetStream transport for the WebSocket gateway integration.
 *
 * Streams are durable and CONVERSATION-scoped (not connection-scoped) so a
 * client that reconnects with a fresh socket can replay events produced after
 * its previous connection dropped — e.g. a background job that finishes hours
 * later. The platform owns this durable contract; the consumer/gateway that
 * relays to a browser is the caller's application (see examples/nats-stream.ts).
 *
 * Subject: `v1.<accountId>.<agentId>.ws.response.<token>` where
 * `<token> = base64url(publicConversationKey)` (the conversationKey is not a
 * safe NATS subject token on its own). The replay cursor is the JetStream
 * message sequence (`JsMsg.seq`), not the per-invocation envelope `sequence`.
 */

import {
  connect,
  DeliverPolicy,
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  type ConsumerMessages,
  type JetStreamClient,
  type NatsConnection,
} from "nats";

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
const RESPONSE_STREAM_NAME = "WS_RESPONSES";
const RESPONSE_SUBJECT_WILDCARD = "v1.*.*.ws.response.*";
const NANOS_PER_MS = 1_000_000;
// How long a finished stream stays replayable for a reconnecting client.
const RESPONSE_STREAM_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RESPONSE_STREAM_MAX_MSGS_PER_SUBJECT = 5_000;

export class LiveNatsPublisher implements NatsPublisher {
  private connectionPromise: Promise<NatsConnection> | null = null;
  private jetstreamPromise: Promise<JetStreamClient> | null = null;
  private sequence = 0;

  constructor(
    private readonly url: string,
    private readonly headers: NatsEventHeaders,
  ) {}

  private async getConnection(): Promise<NatsConnection> {
    if (!this.connectionPromise) {
      this.connectionPromise = connect({ servers: this.url, timeout: 5000 }).catch((err) => {
        this.connectionPromise = null;
        throw err;
      });
    }
    return this.connectionPromise;
  }

  private async getJetStream(): Promise<JetStreamClient> {
    if (!this.jetstreamPromise) {
      this.jetstreamPromise = (async () => {
        const connection = await this.getConnection();
        await ensureResponseStream(connection);
        return connection.jetstream();
      })().catch((err) => {
        this.jetstreamPromise = null;
        throw err;
      });
    }
    return this.jetstreamPromise;
  }

  async publish(data: Record<string, unknown>): Promise<void> {
    try {
      const js = await this.getJetStream();
      this.sequence++;
      const subject = streamResponseSubject(
        this.headers.accountId,
        this.headers.agentId,
        this.headers.conversationKey,
      );
      const event = {
        type: "stream",
        headers: this.headers,
        data,
        sequence: this.sequence,
      };
      // JetStream publish persists to the stream and awaits a server ack, so the
      // message survives the producing Lambda and the client socket. A
      // reconnecting consumer replays it from the stream by sequence/time.
      await js.publish(subject, new TextEncoder().encode(JSON.stringify(event)));
    } catch {
      // Publishing is best-effort per event; close() drains queued writes.
    }
  }

  async close(): Promise<void> {
    if (this.connectionPromise) {
      try {
        const connection = await this.connectionPromise;
        // Drain flushes pending publishes for this invocation before closing. It
        // does not affect other concurrent Lambda invocations.
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
          storage: StorageType.File,
          discard: DiscardPolicy.Old,
          max_age: RESPONSE_STREAM_MAX_AGE_MS * NANOS_PER_MS,
          max_msgs_per_subject: RESPONSE_STREAM_MAX_MSGS_PER_SUBJECT,
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
 * Open a replayable read of a conversation's response stream. With
 * `startSequence` the consumer resumes from that JetStream sequence (a
 * reconnecting client passes the last `JsMsg.seq` it saw); otherwise it replays
 * from the start. Returns an async-iterable of JsMsg; decode `msg.data` as a
 * {@link NatsStreamEvent}. Intended as a reference for callers building a
 * gateway — the platform provides the durable stream, the caller relays it.
 */
export async function readConversationStream(options: {
  connection: NatsConnection;
  accountId: string;
  agentId: string;
  conversationKey: string;
  startSequence?: number;
}): Promise<ConsumerMessages> {
  await ensureResponseStream(options.connection);
  const js = options.connection.jetstream();
  const subject = streamResponseSubject(options.accountId, options.agentId, options.conversationKey);
  const consumer = await js.consumers.get(RESPONSE_STREAM_NAME, {
    filterSubjects: subject,
    deliver_policy: typeof options.startSequence === "number"
      ? DeliverPolicy.StartSequence
      : DeliverPolicy.All,
    ...(typeof options.startSequence === "number" ? { opt_start_seq: options.startSequence } : {}),
  });
  return consumer.consume();
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
