/**
 * NATS publisher for WebSocket gateway integration.
 * Wraps Vercel AI SDK stream events with routing headers and publishes
 * them to a connection-scoped NATS subject.
 */

import { connect, type NatsConnection } from "nats";

export interface NatsPublisher {
  ready(): Promise<void>;
  publish(data: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

export interface NatsEventHeaders {
  accountId: string;
  agentId: string;
  conversationKey: string;
  eventId: string;
  connectionId: string;
}

export interface NatsStreamEvent {
  type: "stream";
  headers: NatsEventHeaders;
  data: Record<string, unknown>;
  sequence: number;
}

export class LiveNatsPublisher implements NatsPublisher {
  private connectionPromise: Promise<NatsConnection> | null = null;
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

  async ready(): Promise<void> {
    await this.getConnection();
  }

  async publish(data: Record<string, unknown>): Promise<void> {
    try {
      const connection = await this.getConnection();
      this.sequence += 1;
      const subject = streamResponseSubject(
        this.headers.accountId,
        this.headers.agentId,
        this.headers.connectionId,
      );
      const event = {
        type: "stream",
        headers: this.headers,
        data: data,
        sequence: this.sequence,
      };
      // Core NATS publish only enqueues on this client connection; it does not
      // return a server ack. If this moves to JetStream, use JetStream publish
      // acks/backpressure instead of treating drain as persistence confirmation.
      connection.publish(subject, new TextEncoder().encode(JSON.stringify(event)));
    } catch {
      // Publishing is best-effort per event; close() drains queued writes.
    }
  }

  async close(): Promise<void> {
    if (this.connectionPromise) {
      try {
        const connection = await this.connectionPromise;
        // Drain sends pending outbound messages for this invocation's connection
        // before closing. It does not affect other concurrent Lambda invocations.
        await connection.drain();
      } catch {
        // Ignore drain errors.
      }
    }
  }
}

export function streamResponseSubject(accountId: string, agentId: string, connectionId: string): string {
  return `v1.${accountId}.${agentId}.ws.response.${connectionId}`;
}