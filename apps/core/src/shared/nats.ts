// WS_RESPONSES is a resume buffer, not the source of truth: output ages out at max_age and no
// event purges its subject, since later FIFO work may still publish or attach there.

import { connect as connectTcp } from "nats";
import {
  connect as connectWebSocket,
  DeliverPolicy,
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  type ConsumerConfig,
  type ConsumerMessages,
  type JetStreamManager,
  type NatsConnection,
} from "nats.ws";

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
  // Label only: the subject is keyed on the conversation, so a reconnect keeps its stream.
  connectionId: string;
}

export interface NatsStreamEvent {
  type: "stream";
  headers: NatsEventHeaders;
  data: Record<string, unknown>;
  sequence: number;
}

const RESPONSE_STREAM_NAME = "WS_RESPONSES";
const RESPONSE_SUBJECT_WILDCARD = "v1.*.*.ws.response.*";
const RESPONSE_STREAM_STORAGE = StorageType.File;
const NANOS_PER_MS = 1_000_000;
const RESPONSE_STREAM_MAX_AGE_MS = 3 * 60 * 1000;
const RESPONSE_STREAM_MAX_MSGS_PER_SUBJECT = 2_000;
const RESPONSE_STREAM_DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

// A span publishes once per state (running, ok): distinct messages, so no duplicate_window.
const OBSERVABILITY_STREAM_NAME = "OBSERVABILITY";
const OBSERVABILITY_SUBJECT_WILDCARDS = [
  "v1.*.*.*.logs.>",
  "v1.*.*.*.traces.>",
];
const OBSERVABILITY_STREAM_STORAGE = StorageType.File;
const OBSERVABILITY_STREAM_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const OBSERVABILITY_STREAM_MAX_BYTES = 512 * 1024 * 1024;
const OBSERVABILITY_STREAM_MAX_MSGS_PER_SUBJECT = 20_000;

// Refuses only NATS-reserved characters: virtual subagent ids carry `~` from their task id.
const SUBJECT_ID_PATTERN = /^[^\s.*>]+$/;

export async function connectNats(options: {
  servers: string;
  token?: string;
  timeout?: number;
  // -1 retries forever; unset keeps the nats.js default (10 attempts, then close).
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

let ensureStreamPromise: Promise<void> | undefined;

export async function ensureResponseStream(
  connection: NatsConnection,
): Promise<void> {
  if (!ensureStreamPromise) {
    ensureStreamPromise = (async () => {
      const jsm = await jetstreamManagerFor(connection);
      // Only the limit knobs are mutable after creation, so update applies them in place.
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
        await jsm.streams.update(RESPONSE_STREAM_NAME, config).catch(() => {});

        return;
      } catch {}
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
      ensureStreamPromise = undefined;
      throw err;
    });
  }

  return ensureStreamPromise;
}

let ensureObservabilityStreamPromise: Promise<void> | undefined;

export async function ensureObservabilityStream(
  connection: NatsConnection,
): Promise<void> {
  if (!ensureObservabilityStreamPromise) {
    ensureObservabilityStreamPromise = (async () => {
      const jsm = await jetstreamManagerFor(connection);
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
      } catch {}
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

export async function flushObservabilityNats(): Promise<void> {
  if (!_natsConn) return;
  try {
    await _natsConn.flush();
  } catch {}
}

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

export async function conversationLastSequence(options: {
  connection: NatsConnection;
  accountId: string;
  agentId: string;
  conversationKey: string;
}): Promise<number | null> {
  try {
    const jsm = await jetstreamManagerFor(options.connection);
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
  const jsm = await jetstreamManagerFor(options.connection);
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
      // Retention can evict the subject between info and this read: treat it as empty.
      bufferedCount = 0;
    }
  }

  return {
    generation: Buffer.from(created, "utf8").toString("base64url"),
    lastSequence: lastSequence,
    bufferedCount: bufferedCount,
  };
}

// Head-only eviction: a retained cursor proves every later message on its subject is replayable.
export async function retainedMessageSubject(
  connection: NatsConnection,
  sequence: number,
): Promise<string | null> {
  try {
    const jsm = await jetstreamManagerFor(connection);
    const message = await jsm.streams.getMessage(RESPONSE_STREAM_NAME, {
      seq: sequence,
    });

    return message.subject;
  } catch {
    return null;
  }
}

// No policy for from-start: an ordered consumer defaults to it, and an explicit
// `deliver_policy: All` stalls it (delivers nothing).
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

export function subjectToken(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

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

// checkAPI: false skips the account-info probe every fresh manager would send first.
const jetstreamManagers = new WeakMap<
  NatsConnection,
  Promise<JetStreamManager>
>();

function jetstreamManagerFor(
  connection: NatsConnection,
): Promise<JetStreamManager> {
  let manager = jetstreamManagers.get(connection);
  if (!manager) {
    manager = connection.jetstreamManager({ checkAPI: false });
    jetstreamManagers.set(connection, manager);
    void manager.catch((): void => {
      jetstreamManagers.delete(connection);
    });
  }

  return manager;
}
