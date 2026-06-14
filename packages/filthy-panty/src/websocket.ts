/**
 * WebSocket client for deployed-agent endpoints.
 * Uses the same core service base URL as the HTTP/SSE client.
 */

import { DEFAULT_CORE_BASE_URL, normalizeHttpServiceUrl } from "./client.ts";
import { stripTrailingSlash } from "./config.ts";

const DEFAULT_CONNECT_TIMEOUT_MS = 2000;
const WS_CONNECTING = 0;
const WS_OPEN = 1;

export type WebSocketServerMessage =
  | { type: "meta"; sessionId: string; taskId: string }
  | { type: "sse"; chunk: string }
  | { type: "continuation_delta"; delta: string }
  | { type: "subagent_delta"; sessionId: string; taskId: string; agentName?: string; delta: string }
  | {
    type: "subagent_activity";
    sessionId: string;
    taskId: string;
    agentName?: string;
    phase: "started" | "tool_call" | "tool_result";
    toolNames?: string[];
  }
  | { type: "subagent_result"; output: string }
  | { type: "done" }
  | { type: "error"; error: string; status?: number };

export interface WebSocketRunInput {
  endpointId: string;
  message: string;
  sessionId?: string;
  projectSlug?: string;
  environmentSlug?: string;
  signal?: AbortSignal;
}

export interface WebSocketHandlers {
  onMessage?(message: WebSocketServerMessage): void;
  onMeta?(meta: Extract<WebSocketServerMessage, { type: "meta" }>): void;
  onSse?(chunk: string): void;
  onContinuationDelta?(delta: string): void;
  onSubagentDelta?(event: Extract<WebSocketServerMessage, { type: "subagent_delta" }>): void;
  onSubagentActivity?(event: Extract<WebSocketServerMessage, { type: "subagent_activity" }>): void;
  onSubagentResult?(output: string): void;
  onDone?(): void;
  onError?(error: Error): void;
}

export interface WebSocketSubscription {
  readonly url: string;
  close(code?: number, reason?: string): void;
}

export interface FilthyPantyWebSocketClientOptions {
  /** Base URL of the core service. Use `https://...`; the client converts it to `wss://...`. */
  baseUrl?: string;
  /** Hostname or URL of the core service. `app.beeblast.co` becomes `https://app.beeblast.co`. */
  host?: string;
  apiKey?: string;
  WebSocket?: WebSocketConstructorLike;
  connectTimeoutMs?: number;
}

export interface WebSocketConstructorLike {
  new (url: string): WebSocketLike;
}

export interface WebSocketLike {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export class FilthyPantyWebSocketClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly WebSocketImpl?: WebSocketConstructorLike;
  private readonly connectTimeoutMs: number;

  constructor(options: FilthyPantyWebSocketClientOptions) {
    this.baseUrl = normalizeWebSocketServiceUrl(options.baseUrl ||
      options.host ||
      process.env.FILTHY_PANTY_BASE_URL ||
      process.env.FILTHY_PANTY_HOST ||
      DEFAULT_CORE_BASE_URL);
    this.apiKey = options.apiKey ||
      process.env.FILTHY_PANTY_API_KEY ||
      "";
    if (!this.apiKey) throw new Error("FilthyPantyWebSocketClient requires apiKey or FILTHY_PANTY_API_KEY.");
    this.WebSocketImpl = options.WebSocket;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  subscribe(input: WebSocketRunInput, handlers: WebSocketHandlers = {}): WebSocketSubscription {
    const WebSocketImpl = this.resolveWebSocket();
    const url = this.buildUrl(input);
    const socket = new WebSocketImpl(url);
    let opened = false;
    let closed = false;
    const timeout = setTimeout(() => {
      if (!opened) fail(new Error(`Cannot access the WebSocket service at ${this.baseUrl}.`));
    }, this.connectTimeoutMs);

    const close = (code = 1000, reason = "client closed") => {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onAbort);
      if (socket.readyState === WS_OPEN || socket.readyState === WS_CONNECTING) {
        socket.close(code, reason);
      }
    };

    const fail = (error: Error) => {
      handlers.onError?.(error);
      close(1011, error.message);
    };

    const finish = () => {
      handlers.onDone?.();
      close(1000, "done");
    };

    const onAbort = () => {
      if (socket.readyState === WS_OPEN) {
        socket.send(JSON.stringify({ type: "cancel" }));
      }
      fail(new Error("WebSocket run aborted."));
    };

    input.signal?.addEventListener("abort", onAbort, { once: true });

    socket.onopen = () => {
      opened = true;
      clearTimeout(timeout);
      if (input.signal?.aborted) {
        onAbort();
        return;
      }

      socket.send(JSON.stringify({
        type: "execute",
        message: input.message,
        sessionId: input.sessionId,
      }));
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const payload = parseServerMessage(event.data);
      if (!payload) return;

      handlers.onMessage?.(payload);

      switch (payload.type) {
        case "meta":
          handlers.onMeta?.(payload);
          break;
        case "sse":
          handlers.onSse?.(payload.chunk);
          break;
        case "continuation_delta":
          handlers.onContinuationDelta?.(payload.delta);
          break;
        case "subagent_delta":
          handlers.onSubagentDelta?.(payload);
          break;
        case "subagent_activity":
          handlers.onSubagentActivity?.(payload);
          break;
        case "subagent_result":
          handlers.onSubagentResult?.(payload.output);
          break;
        case "done":
          finish();
          break;
        case "error":
          fail(new Error(payload.error || "WebSocket stream error."));
          break;
      }
    };

    socket.onerror = () => {
      fail(new Error(`Cannot access the WebSocket service at ${this.baseUrl}.`));
    };

    socket.onclose = (event) => {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onAbort);
      if (closed || event.code === 1000) return;
      fail(new Error(event.reason || "WebSocket connection closed."));
    };

    return {
      url: url,
      close: close,
    };
  }

  async *stream(input: WebSocketRunInput): AsyncGenerator<WebSocketServerMessage> {
    const queue: WebSocketServerMessage[] = [];
    let done = false;
    let error: Error | null = null;
    let wake: (() => void) | null = null;

    const wakeReader = () => {
      wake?.();
      wake = null;
    };

    const subscription = this.subscribe(input, {
      onMessage(message) {
        queue.push(message);
        wakeReader();
      },
      onDone() {
        done = true;
        wakeReader();
      },
      onError(nextError) {
        error = nextError;
        wakeReader();
      },
    });

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (error) throw error;
        if (done) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      subscription.close();
    }
  }

  async *streamSse(input: WebSocketRunInput): AsyncGenerator<string> {
    for await (const message of this.stream(input)) {
      if (message.type === "sse") {
        yield message.chunk;
      }
      if (message.type === "error") {
        throw new Error(message.error || "WebSocket stream error.");
      }
    }
  }

  buildUrl(input: Pick<WebSocketRunInput, "endpointId" | "projectSlug" | "environmentSlug">): string {
    const projectPrefix = input.projectSlug ? `/${input.projectSlug}` : "";
    const environmentPrefix = input.environmentSlug ? `/${input.environmentSlug}` : "";
    const wsBaseUrl = toWebSocketBaseUrl(this.baseUrl);

    return `${wsBaseUrl}/v1${projectPrefix}/agents${environmentPrefix}/${encodeURIComponent(input.endpointId)}/ws` +
      `?token=${encodeURIComponent(this.apiKey)}`;
  }

  private resolveWebSocket(): WebSocketConstructorLike {
    const WebSocketImpl = this.WebSocketImpl ?? (globalThis as { WebSocket?: WebSocketConstructorLike }).WebSocket;
    if (!WebSocketImpl) {
      throw new Error("WebSocket is not available. Pass a WebSocket implementation in FilthyPantyWebSocketClient options.");
    }

    return WebSocketImpl;
  }
}

export function toWebSocketBaseUrl(url: string): string {
  const parsed = new URL(normalizeWebSocketServiceUrl(url));
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  if (parsed.protocol === "http:") parsed.protocol = "ws:";

  return stripTrailingSlash(parsed.toString());
}

function normalizeWebSocketServiceUrl(value: string): string {
  const trimmed = value.trim();
  if (/^wss?:\/\//.test(trimmed)) return stripTrailingSlash(trimmed);

  return normalizeHttpServiceUrl(trimmed);
}

function parseServerMessage(data: string): WebSocketServerMessage | null {
  try {
    const value = JSON.parse(data) as WebSocketServerMessage;
    return typeof value === "object" && value !== null && typeof value.type === "string" ? value : null;
  } catch {
    return null;
  }
}
