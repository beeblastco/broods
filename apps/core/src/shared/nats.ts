/**
 * NATS transport for the WebSocket gateway integration.
 *
 * Each response chunk is published ONCE to a conversation-scoped subject via
 * core NATS; the durable `WS_RESPONSES` JetStream stream is bound to that
 * subject and captures the same message. A connected client reads live via core
 * `subscribe`; a client that dropped mid-stream resumes the still-streaming turn
 * from the JetStream consumer, then continues live.
 *
 * Subject: `v1.<accountId>.<agentId>.ws.response.<token>` where
 * `<token> = base64url(publicConversationKey)` (the conversationKey is not a
 * safe NATS subject token on its own). Ordering cursor: the JetStream message
 * sequence (`JsMsg.seq`) for stream readers, or the envelope `sequence`/`eventId`
 * for core subscribers; dedup a core->stream switch by either.
 *
 * The stream is a short-lived RESUME buffer, not the source of truth. The
 * conversation/status database is. Output is retained until `max_age`; one event
 * never purges the conversation-scoped subject because later FIFO work may still
 * be publishing or attachable there.
 *
 * {@link connectNats} picks the transport from the `NATS_URL` scheme:
 * `nats://`/`tls://` uses the core TCP client, `wss://`/`ws://` uses `nats.ws`.
 * NATS is in-cluster only: core and the gateway both dial `nats://` on the
 * cluster service, and nothing outside the cluster reaches it.
 */

import { connect as connectTcp } from "nats";
import {
  connect as connectWebSocket,
  DeliverPolicy,
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  type ConsumerConfig,
  type ConsumerMessages,
  type NatsConnection,
  type Subscription,
} from "nats.ws";

export type { NatsConnection };

/** One run's response stream; core's implementation is `harness/nats-publisher.ts`. */
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
const RESPONSE_STREAM_STORAGE = StorageType.File; // Memory = faster/cheaper, lost on restart
const NANOS_PER_MS = 1_000_000;
// Three minutes permits reconnect/attach without retaining token output long term.
const RESPONSE_STREAM_MAX_AGE_MS = 3 * 60 * 1000;
const RESPONSE_STREAM_MAX_MSGS_PER_SUBJECT = 2_000;
// Dedup window for Nats-Msg-Id-tagged publishes (retries within it collapse).
const RESPONSE_STREAM_DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

// Durable observability stream. Captures every logs/traces publish so the
// dashboard sees recent activity on (re)connect at full fidelity, even for a run
// that happened while no tab was watching. Tempo/Loki own anything older than
// max_age. A span is published several times (running -> ok); those are distinct
// messages, not duplicates, so there is no Nats-Msg-Id / duplicate_window here.
const OBSERVABILITY_STREAM_NAME = "OBSERVABILITY";
const OBSERVABILITY_SUBJECT_WILDCARDS = [
  "v1.*.*.*.logs.>",
  "v1.*.*.*.traces.>",
];
const OBSERVABILITY_STREAM_STORAGE = StorageType.File;
// Recent-history window the gateway can replay on connect. Kept modest because
// it is only the live/recent buffer; Tempo/Loki own the long tail.
const OBSERVABILITY_STREAM_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const OBSERVABILITY_STREAM_MAX_BYTES = 512 * 1024 * 1024;
const OBSERVABILITY_STREAM_MAX_MSGS_PER_SUBJECT = 20_000;

// Account and agent ids go into subjects raw, so they must be one token with no
// wildcard. Only the characters NATS reserves are refused: virtual subagent ids
// carry `~` from their task id.
const SUBJECT_ID_PATTERN = /^[^\s.*>]+$/;

// Both transports ship the same base client + JetStream API, so the returned
// connection is interchangeable for every helper here. Pass `token` for
// token-auth servers.
export async function connectNats(options: {
  servers: string;
  token?: string;
  timeout?: number;
  // -1 = retry forever. Long-lived relays (the gateway) pass -1; short-lived
  // callers keep the nats.js default (10 attempts, then the connection closes).
  maxReconnectAttempts?: number;
}): Promise<NatsConnection> {
  const connectOptions = {
    servers: options.servers,
    token: options.token,
    timeout: options.timeout ?? 5000,
    ...(options.maxReconnectAttempts !== undefined
      ? { maxReconnectAttempts: options.maxReconnectAttempts }
      : {}),
  };
  const useWebSocket = /^wss?:\/\//i.test(options.servers);
  const connection = useWebSocket
    ? await connectWebSocket(connectOptions)
    : await connectTcp(connectOptions);

  return connection as unknown as NatsConnection;
}

// One memoized connection per process for every core publish: observability
// logs and spans, and the WebSocket response stream. Returns null when NATS is
// unconfigured. It reconnects forever, and a connection that still closes
// (auth revoked, drained) clears the memo so the next call dials again.
let _natsConn: NatsConnection | null = null;
let _natsConnPromise: Promise<NatsConnection> | null = null;

export function getSharedNatsConn(): Promise<NatsConnection> | null {
  const url = process.env.NATS_URL?.trim();
  if (!url) return null;
  const token = process.env.NATS_TOKEN?.trim() || undefined;

  if (_natsConn) return Promise.resolve(_natsConn);
  if (_natsConnPromise) return _natsConnPromise;

  _natsConnPromise = connectNats({
    servers: url,
    token: token,
    timeout: 3000,
    maxReconnectAttempts: -1,
  })
    .then((connection): NatsConnection => {
      _natsConn = connection;
      _natsConnPromise = null;
      void connection.closed().then((): void => {
        if (_natsConn === connection) _natsConn = null;
      });

      return connection;
    })
    .catch((err: unknown): never => {
      _natsConnPromise = null;
      throw err;
    });

  return _natsConnPromise;
}

// Create the response stream once per process; idempotent across concurrent
// invocations (a racing creator just sees "stream already exists").
let ensureStreamPromise: Promise<void> | undefined;

export async function ensureResponseStream(
  connection: NatsConnection,
): Promise<void> {
  if (!ensureStreamPromise) {
    ensureStreamPromise = (async () => {
      const jsm = await connection.jetstreamManager();
      // retention/storage/name are immutable after creation; the retention knobs
      // (max_age, max_msgs_per_subject, duplicate_window) are mutable, so apply
      // them on update too. That's how a shortened buffer reaches an existing
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
        if (
          !/already in use|already exists/i.test(
            err instanceof Error ? err.message : String(err),
          )
        ) {
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

// Create the observability stream once per process; idempotent across concurrent
// invocations and across core + gateway (whoever runs first wins the race).
let ensureObservabilityStreamPromise: Promise<void> | undefined;

export async function ensureObservabilityStream(
  connection: NatsConnection,
): Promise<void> {
  if (!ensureObservabilityStreamPromise) {
    ensureObservabilityStreamPromise = (async () => {
      const jsm = await connection.jetstreamManager();
      // retention/storage/name are immutable after creation; the limit knobs are
      // mutable, so apply them on update too (how a retuned window reaches an
      // existing stream without a destructive recreate).
      const config = {
        name: OBSERVABILITY_STREAM_NAME,
        subjects: OBSERVABILITY_SUBJECT_WILDCARDS,
        retention: RetentionPolicy.Limits,
        storage: OBSERVABILITY_STREAM_STORAGE,
        discard: DiscardPolicy.Old,
        max_age: OBSERVABILITY_STREAM_MAX_AGE_MS * NANOS_PER_MS,
        max_bytes: OBSERVABILITY_STREAM_MAX_BYTES,
        max_msgs_per_subject: OBSERVABILITY_STREAM_MAX_MSGS_PER_SUBJECT,
      };
      try {
        await jsm.streams.info(OBSERVABILITY_STREAM_NAME);
        await jsm.streams
          .update(OBSERVABILITY_STREAM_NAME, config)
          .catch(() => {});

        return;
      } catch {
        // Not found: create it below.
      }
      try {
        await jsm.streams.add(config);
      } catch (err) {
        if (
          !/already in use|already exists/i.test(
            err instanceof Error ? err.message : String(err),
          )
        ) {
          throw err;
        }
      }
    })().catch((err) => {
      ensureObservabilityStreamPromise = undefined;
      throw err;
    });
  }

  return ensureObservabilityStreamPromise;
}

/**
 * Gateway read path: a JetStream consumer over the observability stream filtered
 * to one project/stage scope. `startTime` (ISO) replays recent history from that
 * point and the ordered consumer keeps delivering live, so one consumer both
 * backfills and tails. Decode `msg.data` as an ObservabilityLogEntry (logs) or
 * ObservabilitySpanRow (traces).
 */
export async function readObservabilityStream(options: {
  connection: NatsConnection;
  stream: "logs" | "traces";
  accountId: string;
  project: string;
  stage: string;
  startTime?: string;
}): Promise<ConsumerMessages> {
  await ensureObservabilityStream(options.connection);
  const js = options.connection.jetstream();
  const wildcard =
    options.stream === "logs" ? logsSubjectWildcard : tracesSubjectWildcard;
  const subject = wildcard(options.accountId, options.project, options.stage);
  const consumer = await js.consumers.get(OBSERVABILITY_STREAM_NAME, {
    filterSubjects: subject,
    ...consumerStartPolicy(undefined, options.startTime),
  });

  return consumer.consume();
}

/**
 * Flush the shared observability connection so fire-and-forget log/span publishes
 * reach the server before the request returns or the process shuts down.
 * Best-effort; a flush failure never affects the run.
 */
export async function flushObservabilityNats(): Promise<void> {
  if (!_natsConn) return;
  try {
    await _natsConn.flush();
  } catch {
    // Best-effort: a NATS hiccup must never affect the run.
  }
}

/**
 * Live read path: a core subscription to a conversation's response subject.
 * Decode `msg.data` as a {@link NatsStreamEvent}. There is no replay, so use
 * {@link readConversationStream} to catch up after a disconnect.
 */
export function subscribeConversationLive(options: {
  connection: NatsConnection;
  accountId: string;
  agentId: string;
  conversationKey: string;
}): Subscription {
  return options.connection.subscribe(
    streamResponseSubject(
      options.accountId,
      options.agentId,
      options.conversationKey,
    ),
  );
}

/**
 * Replay read path: a JetStream consumer over a conversation's stored stream.
 * `startSequence` resumes from a known `JsMsg.seq`; `startTime` resumes from an
 * ISO timestamp (for switching over from a core subscription, which doesn't see
 * `seq`); neither replays from the start. Decode `msg.data` as a
 * {@link NatsStreamEvent}.
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
  const subject = streamResponseSubject(
    options.accountId,
    options.agentId,
    options.conversationKey,
  );
  const consumer = await js.consumers.get(RESPONSE_STREAM_NAME, {
    filterSubjects: subject,
    ...consumerStartPolicy(options.startSequence, options.startTime),
  });

  return consumer.consume();
}

/**
 * How many messages are currently buffered for a conversation. 0 means no replay
 * output is retained for the subject, so a reconnecting client must use the
 * durable terminal status/result instead of assuming token replay exists.
 */
export async function conversationBufferedCount(options: {
  connection: NatsConnection;
  accountId: string;
  agentId: string;
  conversationKey: string;
}): Promise<number> {
  try {
    const jsm = await options.connection.jetstreamManager();
    const subject = streamResponseSubject(
      options.accountId,
      options.agentId,
      options.conversationKey,
    );
    const info = await jsm.streams.info(RESPONSE_STREAM_NAME, {
      subjects_filter: subject,
    });

    return (
      (info.state.subjects as Record<string, number> | undefined)?.[subject] ??
      0
    );
  } catch {
    return 0;
  }
}

// Bounds future-cursor rejection: a client can never hold a cursor beyond the
// last sequence published for its subject; null when nothing is retained.
export async function conversationLastSequence(options: {
  connection: NatsConnection;
  accountId: string;
  agentId: string;
  conversationKey: string;
}): Promise<number | null> {
  try {
    const jsm = await options.connection.jetstreamManager();
    const message = await jsm.streams.getMessage(RESPONSE_STREAM_NAME, {
      last_by_subj: streamResponseSubject(
        options.accountId,
        options.agentId,
        options.conversationKey,
      ),
    });

    return message.seq;
  } catch {
    return null;
  }
}

// Every sequence here is scoped to the conversation's own subject; `state`
// boundaries on the shared stream belong to whichever conversation published
// them. There is no first sequence because the client API cannot resolve one
// per subject.
export async function conversationReplaySnapshot(options: {
  connection: NatsConnection;
  accountId: string;
  agentId: string;
  conversationKey: string;
}): Promise<{
  generation: string;
  lastSequence: number;
  bufferedCount: number;
}> {
  await ensureResponseStream(options.connection);
  const jsm = await options.connection.jetstreamManager();
  const subject = streamResponseSubject(
    options.accountId,
    options.agentId,
    options.conversationKey,
  );
  const info = await jsm.streams.info(RESPONSE_STREAM_NAME, {
    subjects_filter: subject,
  });
  const created =
    typeof info.created === "string" ? info.created : String(info.created);
  let bufferedCount =
    (info.state.subjects as Record<string, number> | undefined)?.[subject] ?? 0;
  let lastSequence = info.state.last_seq;
  if (bufferedCount > 0) {
    try {
      const last = await jsm.streams.getMessage(RESPONSE_STREAM_NAME, {
        last_by_subj: subject,
      });
      lastSequence = last.seq;
    } catch {
      // Retention can evict the subject between the filtered info and direct
      // reads. Treat that race as an empty snapshot and tail from the stream
      // boundary instead of failing the attach.
      bufferedCount = 0;
    }
  }

  return {
    generation: Buffer.from(created, "utf8").toString("base64url"),
    lastSequence: lastSequence,
    bufferedCount: bufferedCount,
  };
}

// With head-only eviction, a retained cursor message proves every later message
// for its subject is still replayable; null when the sequence was evicted.
export async function retainedMessageSubject(
  connection: NatsConnection,
  sequence: number,
): Promise<string | null> {
  try {
    const jsm = await connection.jetstreamManager();
    const message = await jsm.streams.getMessage(RESPONSE_STREAM_NAME, {
      seq: sequence,
    });

    return message.subject;
  } catch {
    return null;
  }
}

// Map a resume cursor to a JetStream consumer start policy: by sequence (last
// JsMsg.seq seen), by time (when a core subscriber dropped), or from the start.
// From-start returns no policy on purpose: an ordered consumer already defaults
// to all-from-start, and passing an explicit `deliver_policy: All` stalls it
// (delivers nothing). Only the explicit start cursors are safe to set.
export function consumerStartPolicy(
  startSequence?: number,
  startTime?: string,
): Partial<ConsumerConfig> {
  if (typeof startSequence === "number") {
    return {
      deliver_policy: DeliverPolicy.StartSequence,
      opt_start_seq: startSequence,
    };
  }
  if (startTime) {
    return {
      deliver_policy: DeliverPolicy.StartTime,
      opt_start_time: startTime,
    };
  }

  return {};
}

export function streamResponseSubject(
  accountId: string,
  agentId: string,
  conversationKey: string,
): string {
  if (
    !SUBJECT_ID_PATTERN.test(accountId) ||
    !SUBJECT_ID_PATTERN.test(agentId)
  ) {
    throw new Error("Account and agent ids must be plain NATS subject tokens");
  }

  return `v1.${accountId}.${agentId}.ws.response.${subjectToken(conversationKey)}`;
}

// Encode an arbitrary conversationKey into a single NATS-safe subject token.
// base64url avoids the reserved `.`, `*`, `>`, and whitespace characters; a
// client recomputes the same token from its conversationKey.
export function subjectToken(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

// Observability subjects: v1.<accountId>.<project>.<subjectToken(stage)>.{logs|traces}.<endpointId>.
// The stage segment is base64url-encoded since stage names are free text; the
// gateway reconstructs it from the token scope rather than parsing the subject.

export function logsSubject(
  accountId: string,
  project: string,
  stage: string,
  endpointId: string,
): string {
  return `v1.${accountId}.${project}.${subjectToken(stage)}.logs.${endpointId}`;
}

export function tracesSubject(
  accountId: string,
  project: string,
  stage: string,
  endpointId: string,
): string {
  return `v1.${accountId}.${project}.${subjectToken(stage)}.traces.${endpointId}`;
}

// Wildcards cover all endpoints in a project/stage (dashboard tab / CLI `dev` scope).
export function logsSubjectWildcard(
  accountId: string,
  project: string,
  stage: string,
): string {
  return `v1.${accountId}.${project}.${subjectToken(stage)}.logs.>`;
}

export function tracesSubjectWildcard(
  accountId: string,
  project: string,
  stage: string,
): string {
  return `v1.${accountId}.${project}.${subjectToken(stage)}.traces.>`;
}
