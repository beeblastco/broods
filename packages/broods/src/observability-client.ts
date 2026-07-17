/**
 * Lightweight WebSocket client for the observability gateway's logs stream.
 * Subscribes and yields ObservabilityLogEntry items (backfill then live) until
 * the AbortSignal fires or the socket closes. Imports only the shared contracts.
 */

import { toWebSocketBaseUrl } from "./websocket.ts";
import type {
  LogLevel,
  ObservabilityClientMessage,
  ObservabilityLogEntry,
  ObservabilityServerMessage,
} from "./observability-contracts.ts";

export interface ObservabilityClientOptions {
  baseUrl: string;
  apiKey: string;
  project: string;
  environment: string;
}

export interface ObservabilitySubscribeOptions {
  // Recent lines to backfill from Loki before going live; 0/absent = live-only.
  backfill?: number;
  // Explicitly skip the gateway's recent JetStream replay. Defaults to true when
  // no backfill is requested, matching CLI/client live-tail expectations.
  liveOnly?: boolean;
  minLevel?: LogLevel;
  signal?: AbortSignal;
}

const WS_OPEN = 1;
const WS_CONNECTING = 0;

function buildObservabilityUrl(
  baseUrl: string,
  project: string,
  environment: string,
  apiKey: string,
): string {
  const wsBase = toWebSocketBaseUrl(baseUrl);
  return (
    `${wsBase}/v1/${encodeURIComponent(project)}/${encodeURIComponent(environment)}/observability/ws` +
    `?token=${encodeURIComponent(apiKey)}`
  );
}

function parseServerMessage(data: unknown): ObservabilityServerMessage | null {
  if (typeof data !== "string") return null;
  try {
    const value = JSON.parse(data) as ObservabilityServerMessage;
    return typeof value === "object" &&
      value !== null &&
      typeof (value as { type?: unknown }).type === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}

function resolveWebSocket(): new (url: string) => WebSocket {
  const impl = (globalThis as { WebSocket?: new (url: string) => WebSocket })
    .WebSocket;
  if (!impl) throw new Error("WebSocket is not available in this environment.");
  return impl;
}

/** Continuously stream logs, reconnecting transient socket failures until aborted. */
export async function* subscribeObservabilityLogs(
  options: ObservabilityClientOptions,
  subscribeOptions: ObservabilitySubscribeOptions = {},
): AsyncGenerator<ObservabilityLogEntry> {
  const seen = new Set<string>();
  let retryMs = 500;
  while (!subscribeOptions.signal?.aborted) {
    try {
      for await (const entry of subscribeObservabilityLogsOnce(
        options,
        subscribeOptions,
      )) {
        const key = `${entry.ts}|${entry.eventType}|${entry.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (seen.size > 5_000) seen.delete(seen.values().next().value!);
        retryMs = 500;
        yield entry;
      }
    } catch (error) {
      if (subscribeOptions.signal?.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      if (
        /unauthorized|invalid websocket token|scope does not match/i.test(
          message,
        )
      )
        throw error;
    }
    await reconnectDelay(retryMs, subscribeOptions.signal);
    retryMs = Math.min(retryMs * 2, 5_000);
  }
}

// One socket lifecycle. The exported wrapper above owns reconnect and dedupe.
async function* subscribeObservabilityLogsOnce(
  options: ObservabilityClientOptions,
  subscribeOptions: ObservabilitySubscribeOptions,
): AsyncGenerator<ObservabilityLogEntry> {
  const { baseUrl, apiKey, project, environment } = options;
  const { backfill = 0, minLevel, signal } = subscribeOptions;
  const liveOnly = subscribeOptions.liveOnly ?? backfill <= 0;

  if (signal?.aborted) return;

  const url = buildObservabilityUrl(baseUrl, project, environment, apiKey);
  const displayUrl = url.slice(0, url.indexOf("?"));
  const WebSocketImpl = resolveWebSocket();

  // Queues and flow-control for the generator ↔ WS event loop bridge.
  const entries: ObservabilityLogEntry[] = [];
  let socketError: Error | null = null;
  let done = false;
  let wake: (() => void) | null = null;

  const notify = (): void => {
    wake?.();
    wake = null;
  };

  const socket = new WebSocketImpl(url);

  const cleanup = (): void => {
    if (socket.readyState === WS_OPEN || socket.readyState === WS_CONNECTING) {
      socket.close(1000, "client closed");
    }
    signal?.removeEventListener("abort", onAbort);
  };

  const onAbort = (): void => {
    done = true;
    notify();
    cleanup();
  };

  signal?.addEventListener("abort", onAbort, { once: true });

  socket.onopen = (): void => {
    if (signal?.aborted) {
      cleanup();
      return;
    }
    const msg: ObservabilityClientMessage = {
      type: "subscribe",
      stream: "logs",
      ...(backfill > 0 ? { backfill } : {}),
      ...(liveOnly ? { liveOnly: true } : {}),
      ...(minLevel !== undefined ? { minLevel } : {}),
    };
    socket.send(JSON.stringify(msg));
  };

  socket.onmessage = (event: MessageEvent): void => {
    const msg = parseServerMessage(event.data);
    if (!msg) return;

    switch (msg.type) {
      case "backfill":
        if (msg.stream === "logs") {
          for (const entry of msg.entries as ObservabilityLogEntry[]) {
            entries.push(entry);
          }
          notify();
        }
        break;
      case "log":
        entries.push(msg.entry);
        notify();
        break;
      case "error":
        socketError = new Error(`Observability gateway error: ${msg.error}`);
        done = true;
        notify();
        break;
      case "ready":
        // No-op: the gateway is now live. Nothing to push to the consumer.
        break;
      default:
        break;
    }
  };

  socket.onerror = (): void => {
    socketError = new Error(
      `Cannot connect to the observability gateway at ${displayUrl}.`,
    );
    done = true;
    notify();
  };

  socket.onclose = (event: CloseEvent): void => {
    if (!done) {
      if (event.code !== 1000) {
        socketError = new Error(
          event.reason
            ? `Observability WebSocket closed: ${event.reason}`
            : `Observability WebSocket closed with code ${event.code}.`,
        );
      }
      done = true;
      notify();
    }
  };

  try {
    while (true) {
      if (entries.length > 0) {
        yield entries.shift()!;
        continue;
      }
      if (socketError) throw socketError;
      if (done) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    cleanup();
  }
}

function reconnectDelay(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
