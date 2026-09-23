/**
 * Core's publisher for one WebSocket run's response stream.
 * The subject scheme, stream setup and read paths live in `shared/nats.ts`,
 * which the gateway also compiles, so anything that logs stays here.
 */

import { headers as natsHeaders } from "nats.ws";
import { logError } from "../shared/log.ts";
import {
  ensureResponseStream,
  getSharedNatsConn,
  streamResponseSubject,
  type NatsConnection,
  type NatsEventHeaders,
  type NatsPublisher,
  type NatsStreamEvent,
} from "../shared/nats.ts";

// nats-server's default max_payload, used until the server INFO says otherwise.
const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
// Shared so token publishing does not allocate an encoder per chunk.
const ENCODER = new TextEncoder();
// Room for the Nats-Msg-Id header, which also counts against max_payload.
const HEADER_ALLOWANCE_BYTES = 1024;
// Kept on a frame whose payload was dropped, so a client can still pair it.
const TRUNCATED_FRAME_KEPT_FIELDS = [
  "id",
  "toolCallId",
  "toolName",
  "eventId",
] as const;

export class LiveNatsPublisher implements NatsPublisher {
  private connectionPromise: Promise<NatsConnection> | null = null;
  private streamReady: Promise<void> | null = null;
  private readonly subject: string;
  private sequence = 0;

  constructor(private readonly headers: NatsEventHeaders) {
    this.subject = streamResponseSubject(
      headers.accountId,
      headers.agentId,
      headers.conversationKey,
    );
  }

  /** Flushes this run's publishes. The connection is shared, so it stays open. */
  async close(): Promise<void> {
    if (!this.connectionPromise) return;
    try {
      const connection = await this.connectionPromise;
      await connection.flush();
    } catch {
      // The connect failure was already logged once.
    }
  }

  async publish(data: Record<string, unknown>): Promise<void> {
    const connection = await this.getConnection().catch((): null => null);
    if (!connection) return;
    try {
      // Ensure the stream exists before the first publish so it captures from the
      // first token; memoized, so later tokens skip straight to publishing.
      if (!this.streamReady) {
        this.streamReady = ensureResponseStream(connection);
      }
      await this.streamReady;

      this.sequence++;
      // Core publish: fire-and-forget at core-NATS speed for live subscribers,
      // while the bound stream captures the same message for replay. Nats-Msg-Id
      // makes it idempotent within the stream's duplicate_window so a retry never
      // stores a duplicate.
      const hdrs = natsHeaders();
      hdrs.set("Nats-Msg-Id", `${this.headers.eventId}:${this.sequence}`);
      connection.publish(
        this.subject,
        this.encodeWithinLimit(connection, data),
        { headers: hdrs },
      );
    } catch (err) {
      logError("NATS response publish failed", {
        eventId: this.headers.eventId,
        frameType: data.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * nats.js throws on a frame over max_payload, which publish would swallow.
   * The same frame type goes out without its payload instead, marked
   * `truncated`, so a `done` still ends the stream and the full result stays
   * readable from the run status.
   */
  private encodeWithinLimit(
    connection: NatsConnection,
    data: Record<string, unknown>,
  ): Uint8Array {
    const encoded = ENCODER.encode(JSON.stringify(this.envelope(data)));
    const maxPayload =
      connection.info?.max_payload ?? DEFAULT_MAX_PAYLOAD_BYTES;
    if (encoded.byteLength <= maxPayload - HEADER_ALLOWANCE_BYTES) {
      return encoded;
    }
    logError("NATS response frame over max_payload; payload dropped", {
      eventId: this.headers.eventId,
      frameType: data.type,
      bytes: encoded.byteLength,
    });
    const truncated: Record<string, unknown> = {
      type: data.type,
      truncated: true,
      originalBytes: encoded.byteLength,
    };
    for (const field of TRUNCATED_FRAME_KEPT_FIELDS) {
      if (typeof data[field] === "string") truncated[field] = data[field];
    }

    return ENCODER.encode(JSON.stringify(this.envelope(truncated)));
  }

  private envelope(data: Record<string, unknown>): NatsStreamEvent {
    return {
      type: "stream",
      headers: this.headers,
      data: data,
      sequence: this.sequence,
    };
  }

  // Memoized per run, failure included: re-dialing per chunk would make every
  // awaited publish wait out a connect timeout. The failure is logged once.
  private getConnection(): Promise<NatsConnection> {
    if (!this.connectionPromise) {
      const shared = getSharedNatsConn();
      this.connectionPromise =
        shared ?? Promise.reject(new Error("NATS_URL is not configured"));
      this.connectionPromise.catch((err: unknown): void => {
        logError("NATS connection unavailable; this run streams nothing", {
          eventId: this.headers.eventId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return this.connectionPromise;
  }
}
