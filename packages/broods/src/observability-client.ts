import { toWebSocketBaseUrl, webSocketSubprotocols } from "./websocket.ts";
import type {
  LogLevel,
  ObservabilityClientMessage,
  ObservabilityLogEntry,
  ObservabilityServerMessage,
  ObservabilitySpanRow,
} from "./observability-contracts.ts";

export interface ObservabilityClientOptions {
  baseUrl: string;
  /** Called per connection, so a reconnect can carry a fresh stage ticket. */
  credential: () => Promise<string>;
  project: string;
  stage: string;
}

export interface ObservabilitySubscribeOptions {
  backfill?: number;
  liveOnly?: boolean;
  minLevel?: LogLevel;
  sandboxId?: string;
  signal?: AbortSignal;
  onReconnect?: (attempt: number, reason: string) => void;
  keepReconnecting?: boolean;
}

/** `agentId` is set when the gateway searched only that agent's traces. */
export interface BackfillResult<T> {
  rows: T[];
  error?: string;
  agentId?: string;
}

const WS_OPEN = 1;
const WS_CONNECTING = 0;
const RECONNECT_GIVE_UP_MS = 60_000;
const READY_TIMEOUT_MS = 15_000;

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

export class StageSessionRefusedError extends Error {}

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

async function* subscribeObservabilityLogsOnce(
  options: ObservabilityClientOptions,
  subscribeOptions: ObservabilitySubscribeOptions,
  onLive: () => void,
): AsyncGenerator<ObservabilityLogEntry> {
  const { backfill = 0, minLevel, sandboxId, signal } = subscribeOptions;
  const liveOnly = subscribeOptions.liveOnly ?? backfill <= 0;

  if (signal?.aborted) return;

  const entries: ObservabilityLogEntry[] = [];
  let socketError: Error | null = null;
  let done = false;
  let wake: (() => void) | null = null;

  const notify = (): void => {
    wake?.();
    wake = null;
  };

  const { socket, url } = openObservabilitySocket(
    options,
    await options.credential(),
  );

  // An open socket that never answers would hang beyond the reconnect loop's reach.
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
        break;
      default:
        break;
    }
  };

  socket.onerror = (): void => {
    socketError = new Error(
      `Cannot connect to the observability gateway at ${url}.`,
    );
    done = true;
    notify();
  };

  socket.onclose = (event: CloseEvent): void => {
    if (!done) {
      if (event.code !== 1000) socketError = closedError(event);
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
      await new Promise<void>((resolve): void => {
        wake = resolve;
      });
    }
  } finally {
    cleanup();
  }
}

export async function fetchObservabilityTrace(
  options: ObservabilityClientOptions,
  traceId: string,
): Promise<ObservabilitySpanRow[]> {
  const { error, rows } = await requestBackfill<ObservabilitySpanRow>(
    options,
    { type: "fetchTrace", traceId: traceId },
    "traces",
  );
  if (error) throw new Error(error);

  return rows;
}

/** One page of history with no live tail: what a tool or a one-shot command wants. */
export async function fetchObservabilityLogs(
  options: ObservabilityClientOptions,
  request: { limit: number; minLevel?: LogLevel; sandboxId?: string },
): Promise<ObservabilityLogEntry[]> {
  // The gateway answers a zero backfill with `ready` alone, so no closing frame would come.
  if (request.limit <= 0) return [];
  const { error, rows } = await requestBackfill<ObservabilityLogEntry>(
    options,
    {
      type: "subscribe",
      stream: "logs",
      backfill: request.limit,
      historyOnly: true,
      ...(request.minLevel ? { minLevel: request.minLevel } : {}),
      ...(request.sandboxId ? { sandboxId: request.sandboxId } : {}),
    },
    "logs",
  );
  if (error) throw new Error(error);

  return rows;
}

/** The latest traces' spans with no live tail, and why any of them could not be read. */
export async function fetchObservabilitySpans(
  options: ObservabilityClientOptions,
  limit: number,
  agentId?: string,
): Promise<BackfillResult<ObservabilitySpanRow>> {
  return await requestBackfill<ObservabilitySpanRow>(
    options,
    {
      type: "subscribe",
      stream: "traces",
      backfill: limit,
      historyOnly: true,
      ...(agentId ? { agentId: agentId } : {}),
    },
    "traces",
  );
}

async function requestBackfill<T>(
  options: ObservabilityClientOptions,
  message: ObservabilityClientMessage,
  stream: "logs" | "traces",
): Promise<BackfillResult<T>> {
  const { socket, url } = openObservabilitySocket(
    options,
    await options.credential(),
  );

  return new Promise<BackfillResult<T>>((resolve, reject): void => {
    let settled = false;
    const rows: T[] = [];
    let agentId: string | undefined;
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket.readyState === WS_OPEN || socket.readyState === WS_CONNECTING)
        socket.close(1000, "client closed");
      outcome();
    };
    const fail = (error: Error): void => settle((): void => reject(error));
    const silent = (): void => {
      fail(
        new Error(
          `The observability gateway did not answer within ${READY_TIMEOUT_MS / 1000} s.`,
        ),
      );
    };
    // Each piece restarts it: a long backfill that keeps arriving is not a silent gateway.
    let timer = setTimeout(silent, READY_TIMEOUT_MS);

    socket.onopen = (): void => socket.send(JSON.stringify(message));
    socket.onmessage = (event: MessageEvent): void => {
      const msg = parseServerMessage(event.data);
      if (msg?.type === "error") {
        fail(new Error(`Observability gateway error: ${msg.error}`));
      } else if (msg?.type === "ready") {
        agentId = msg.agentId;
      } else if (msg?.type === "backfill" && msg.stream === stream) {
        rows.push(...(msg.entries as T[]));
        clearTimeout(timer);
        timer = setTimeout(silent, READY_TIMEOUT_MS);
        const { error } = msg;
        if (!msg.more)
          settle((): void =>
            resolve({
              rows: rows,
              ...(error ? { error: error } : {}),
              ...(agentId ? { agentId: agentId } : {}),
            }),
          );
      }
    };
    socket.onerror = (): void => {
      fail(new Error(`Cannot connect to the observability gateway at ${url}.`));
    };
    socket.onclose = (event: CloseEvent): void => fail(closedError(event));
  });
}

// Synchronous, so the caller attaches its handlers before any event can fire.
function openObservabilitySocket(
  options: ObservabilityClientOptions,
  credential: string,
): { socket: WebSocket; url: string } {
  const url = buildObservabilityUrl(
    options.baseUrl,
    options.project,
    options.stage,
  );
  const WebSocketImpl = resolveWebSocket();

  return {
    socket: new WebSocketImpl(url, webSocketSubprotocols(credential)),
    url: url,
  };
}

function closedError(event: CloseEvent): Error {
  return new Error(
    event.reason
      ? `Observability WebSocket closed: ${event.reason}`
      : `Observability WebSocket closed with code ${event.code}.`,
  );
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
