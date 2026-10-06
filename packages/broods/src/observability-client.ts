/**
 * Lightweight WebSocket client for the observability gateway's logs stream.
 * Subscribes and yields ObservabilityLogEntry items (backfill then live) until
 * the AbortSignal fires or the socket closes. Imports only the shared contracts.
 */

import { toWebSocketBaseUrl, webSocketSubprotocols } from "./websocket.ts";
import type {
  LogLevel,
  ObservabilityClientMessage,
  ObservabilityLogEntry,
  ObservabilityServerMessage,
} from "./observability-contracts.ts";

export interface ObservabilityClientOptions {
  baseUrl: string;
  /** Called per connection, so a reconnect can carry a fresh stage ticket. */
  credential: () => Promise<string>;
  project: string;
  stage: string;
}

export interface ObservabilitySubscribeOptions {
  // Recent lines to backfill from Loki before going live; 0/absent = live-only.
  backfill?: number;
  // Explicitly skip the gateway's recent JetStream replay. Defaults to true when
  // no backfill is requested, matching CLI/client live-tail expectations.
  liveOnly?: boolean;
  minLevel?: LogLevel;
  // Tail one sandbox instance's guest output instead of the deployment's logs.
  // The id is the last segment of the instance's log stream (dashboard Instances
  // sheet, or `logStream` on the instance row).
  sandboxId?: string;
  signal?: AbortSignal;
  /** Called before each reconnect, so a terminal can say the tail is down. */
  onReconnect?: (attempt: number, reason: string) => void;
  /** Never give up after a minute down, for a tail that lives as long as its session. */
  keepReconnecting?: boolean;
}

const WS_OPEN = 1;
const WS_CONNECTING = 0;
/** How long the stream may stay down before reconnecting gives up. */
const RECONNECT_GIVE_UP_MS = 60_000;
/** How long a new socket may wait for the gateway's first answer. */
const READY_TIMEOUT_MS = 15_000;

/** Resolves after `ms`, or at once when `signal` aborts; never rejects. */
export function reconnectDelay(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise<void>((resolve): void => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      (): void => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function resolveWebSocket(): new (
  url: string,
  protocols?: string[],
) => WebSocket {
  const impl = (
    globalThis as {
      WebSocket?: new (url: string, protocols?: string[]) => WebSocket;
    }
  ).WebSocket;
  if (!impl) throw new Error("WebSocket is not available in this environment.");

  return impl;
}

/** The server refused to mint a stage credential. Reconnecting cannot fix it. */
export class StageSessionRefusedError extends Error {}

/**
 * Continuously stream logs, reconnecting transient socket failures until
 * aborted. Throws once the stream has been down for a minute.
 */
export async function* subscribeObservabilityLogs(
  options: ObservabilityClientOptions,
  subscribeOptions: ObservabilitySubscribeOptions = {},
): AsyncGenerator<ObservabilityLogEntry> {
  const seen = new Set<string>();
  let retryMs = 500;
  let attempt = 0;
  let downSince = Date.now();
  while (!subscribeOptions.signal?.aborted) {
    let live = false;
    let reason = "the log stream closed";
    try {
      for await (const entry of subscribeObservabilityLogsOnce(
        options,
        subscribeOptions,
        (): void => {
          live = true;
        },
      )) {
        const key = `${entry.ts}|${entry.eventType}|${entry.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (seen.size > 5_000) seen.delete(seen.values().next().value!);
        yield entry;
      }
    } catch (error) {
      if (subscribeOptions.signal?.aborted) return;
      reason = error instanceof Error ? error.message : String(error);
      if (
        error instanceof StageSessionRefusedError ||
        /unauthorized|invalid websocket token|scope does not match/i.test(
          reason,
        )
      )
        throw error;
    }
    if (subscribeOptions.signal?.aborted) return;
    // A stream that went live was up until now, so the outage starts here.
    if (live) {
      retryMs = 500;
      attempt = 0;
      downSince = Date.now();
    }
    if (
      !subscribeOptions.keepReconnecting &&
      Date.now() - downSince >= RECONNECT_GIVE_UP_MS
    ) {
      throw new Error(
        `Gave up reconnecting to the live logs after ${RECONNECT_GIVE_UP_MS / 1000} s. Last error: ${reason}`,
      );
    }
    attempt += 1;
    subscribeOptions.onReconnect?.(attempt, reason);
    await reconnectDelay(retryMs, subscribeOptions.signal);
    retryMs = Math.min(retryMs * 2, 5_000);
  }
}

// One socket lifecycle. The exported wrapper above owns reconnect and dedupe.
// `onLive` fires once the gateway accepts the subscription.
async function* subscribeObservabilityLogsOnce(
  options: ObservabilityClientOptions,
  subscribeOptions: ObservabilitySubscribeOptions,
  onLive: () => void,
): AsyncGenerator<ObservabilityLogEntry> {
  const { baseUrl, credential, project, stage } = options;
  const { backfill = 0, minLevel, sandboxId, signal } = subscribeOptions;
  const liveOnly = subscribeOptions.liveOnly ?? backfill <= 0;

  if (signal?.aborted) return;

  const url = buildObservabilityUrl(baseUrl, project, stage);
  const displayUrl = url;
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

  const socket = new WebSocketImpl(
    url,
    webSocketSubprotocols(await credential()),
  );

  // A socket that opens but never answers would wait forever, out of reach of
  // the reconnect loop above.
  const readyTimer = setTimeout((): void => {
    socketError = new Error(
      `The observability gateway did not answer within ${READY_TIMEOUT_MS / 1000} s.`,
    );
    done = true;
    notify();
  }, READY_TIMEOUT_MS);

  const cleanup = (): void => {
    clearTimeout(readyTimer);
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
      ...(backfill > 0 ? { backfill: backfill } : {}),
      ...(liveOnly ? { liveOnly: true } : {}),
      ...(minLevel !== undefined ? { minLevel: minLevel } : {}),
      ...(sandboxId !== undefined ? { sandboxId: sandboxId } : {}),
    };
    socket.send(JSON.stringify(msg));
  };

  socket.onmessage = (event: MessageEvent): void => {
    const msg = parseServerMessage(event.data);
    if (!msg) return;
    clearTimeout(readyTimer);
    if (msg.type !== "error") onLive();

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
        // The gateway is now live; `onLive` above already recorded it.
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

function buildObservabilityUrl(
  baseUrl: string,
  project: string,
  stage: string,
): string {
  const wsBase = toWebSocketBaseUrl(baseUrl);

  return (
    `${wsBase}/v1/projects/${encodeURIComponent(project)}` +
    `/stages/${encodeURIComponent(stage)}/observability/ws`
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
