// Apart from shared/nats.ts, which the gateway also compiles: anything that logs stays here.

import { headers as natsHeaders } from "nats.ws";
import {
  logError,
  redactWithRunSecrets,
  runSecretValues,
} from "../shared/log.ts";
import { getObservabilityContext } from "../shared/otel.ts";
import {
  ensureResponseStream,
  getSharedNatsConn,
  streamResponseSubject,
  type NatsConnection,
  type NatsEventHeaders,
  type NatsPublisher,
  type NatsStreamEvent,
} from "../shared/nats.ts";

const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const ENCODER = new TextEncoder();
// Headers (Nats-Msg-Id) count against max_payload too.
const HEADER_ALLOWANCE_BYTES = 1024;
const TRUNCATED_FRAME_KEPT_FIELDS = [
  "id",
  "toolCallId",
  "toolName",
  "eventId",
] as const;
// Never scrubbed, so an id that happens to contain a secret still matches its stream.
const STRUCTURAL_FRAME_FIELDS = new Set<string>([
  "type",
  "approvalId",
  ...TRUNCATED_FRAME_KEPT_FIELDS,
]);

export class LiveNatsPublisher implements NatsPublisher {
  private connectionPromise: Promise<NatsConnection> | null = null;
  private streamReady: Promise<void> | null = null;
  private readonly subject: string;
  private sequence = 0;
  private scrubValues: string[] | null = null;
  private scrubValuesFor: readonly string[] | undefined;

  constructor(
    private readonly headers: NatsEventHeaders,
    private readonly secretValues: readonly string[] = [],
  ) {
    this.subject = streamResponseSubject(
      headers.accountId,
      headers.agentId,
      headers.conversationKey,
    );
  }

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
      if (!this.streamReady) {
        this.streamReady = ensureResponseStream(connection);
      }
      await this.streamReady;

      this.sequence++;
      // Core publish for live-subscriber speed; the bound stream still captures it,
      // and Nats-Msg-Id dedupes a retry within the stream's duplicate_window.
      const hdrs = natsHeaders();
      hdrs.set("Nats-Msg-Id", `${this.headers.eventId}:${this.sequence}`);
      connection.publish(
        this.subject,
        this.encodeWithinLimit(connection, this.redactPayload(data)),
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

  // nats.js throws over max_payload; a payload-less frame still lets `done` end the stream.
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

  // Sandbox and workspace secrets join the context after the run starts: read per publish.
  private redactPayload(
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    const contextSecrets = getObservabilityContext()?.secretValues;
    if (!this.scrubValues || contextSecrets !== this.scrubValuesFor) {
      this.scrubValues = [...runSecretValues(), ...this.secretValues];
      this.scrubValuesFor = contextSecrets;
    }
    const safe: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(data)) {
      safe[field] = STRUCTURAL_FRAME_FIELDS.has(field)
        ? value
        : redactWithRunSecrets(value, this.scrubValues);
    }

    return safe;
  }

  private envelope(data: Record<string, unknown>): NatsStreamEvent {
    return {
      type: "stream",
      headers: this.headers,
      data: data,
      sequence: this.sequence,
    };
  }

  // Failure memoized too: re-dialing per chunk would make each publish wait out a timeout.
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
