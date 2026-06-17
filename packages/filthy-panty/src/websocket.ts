/**
 * WebSocket client for deployed-agent endpoints.
 * Uses the gateway URL when configured, or derives one from the core service URL.
 */

import { DEFAULT_CORE_BASE_URL, normalizeHttpServiceUrl } from "./client.ts";
import type { AgentReference } from "./client.ts";
import { stripTrailingSlash } from "./config.ts";
import { resolveRunEvents, type AgentRunEventInput, type AgentRunOverrides } from "./run-input.ts";
import type {
  WebSocketClientCancelMessage,
  WebSocketClientExecuteMessage,
  WebSocketClientMessage,
  WebSocketServerMessage,
  WebSocketStreamMessage,
} from "./websocket-contracts.ts";

const DEFAULT_CONNECT_TIMEOUT_MS = 2000;
const WS_CONNECTING = 0;
const WS_OPEN = 1;
const LAMBDA_FUNCTION_URL_HOST_RE = /\.lambda-url\.[a-z0-9-]+\.on\.aws$/i;

export type WebSocketRunInput = {
  agent?: AgentReference;
  agentId?: string;
  endpointId?: string;
  sessionId?: string;
  eventId?: string;
  projectSlug?: string;
  environmentSlug?: string;
  signal?: AbortSignal;
} & AgentRunEventInput & AgentRunOverrides;

export interface WebSocketHandlers {
  onMessage?(message: WebSocketServerMessage): void;
  onMeta?(meta: Extract<WebSocketServerMessage, { type: "meta" }>): void;
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
      process.env.FILTHY_PANTY_WEBSOCKET_URL ||
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
    const agentId = resolveAgentId(input);
    const accessError = webSocketAccessError(this.baseUrl);
    const socket = new WebSocketImpl(url);
    let opened = false;
    let closed = false;
    const timeout = setTimeout(() => {
      if (!opened) fail(accessError);
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
      close(1011, "websocket error");
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
        agentId,
        events: resolveRunEvents(input),
        sessionId: input.sessionId,
        ...(input.eventId !== undefined ? { eventId: input.eventId } : {}),
        ...(input.system !== undefined ? { system: input.system } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
      }));
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const payload = parseServerMessage(event.data);
      if (!payload) return;

      handlers.onMessage?.(payload);

      switch (payload.type) {
        case "meta":
          handlers.onMeta?.(payload as Extract<WebSocketServerMessage, { type: "meta" }>);
          break;
        case "done":
          finish();
          break;
        case "error":
          fail(new Error(formatWireError(payload.error)));
          break;
      }
    };

    socket.onerror = () => {
      fail(accessError);
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

  buildUrl(input: Pick<WebSocketRunInput, "agent" | "endpointId" | "projectSlug" | "environmentSlug">): string {
    const endpointId = resolveEndpointId(input);
    const projectSlug = input.projectSlug ?? input.agent?.projectSlug;
    const environmentSlug = input.environmentSlug ?? input.agent?.environmentSlug;
    const projectPrefix = projectSlug ? `/${projectSlug}` : "";
    const environmentPrefix = environmentSlug ? `/${environmentSlug}` : "";
    const wsBaseUrl = toWebSocketBaseUrl(this.baseUrl);

    return `${wsBaseUrl}/v1${projectPrefix}/agents${environmentPrefix}/${encodeURIComponent(endpointId)}/ws` +
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

function resolveAgentId(input: Pick<WebSocketRunInput, "agent" | "agentId" | "endpointId">): string {
  const agentId = input.agentId ?? input.agent?.id ?? input.endpointId;
  if (!agentId) {
    throw new Error("WebSocket run requires agent, agentId, or endpointId.");
  }

  return agentId;
}

function resolveEndpointId(input: Pick<WebSocketRunInput, "agent" | "endpointId">): string {
  const endpointId = input.endpointId ?? input.agent?.endpointId ?? input.agent?.id;
  if (!endpointId) {
    throw new Error("WebSocket run requires agent or endpointId.");
  }

  return endpointId;
}

export { FilthyPantyWebSocketClient as WebSocketClient };
export { FilthyPantyWebSocketClient as WebsocketClient };
export type {
  WebSocketClientCancelMessage,
  WebSocketClientExecuteMessage,
  WebSocketClientMessage,
  WebSocketServerMessage,
  WebSocketStreamMessage,
};

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

function webSocketAccessError(baseUrl: string): Error {
  const host = new URL(baseUrl).hostname;
  if (LAMBDA_FUNCTION_URL_HOST_RE.test(host)) {
    return new Error(
      `Cannot access the WebSocket service at ${baseUrl}. AWS Lambda Function URLs do not support WebSocket upgrades; ` +
      "set FILTHY_PANTY_WEBSOCKET_URL or FILTHY_PANTY_HOST to the deployed WebSocket gateway URL instead.",
    );
  }

  return new Error(`Cannot access the WebSocket service at ${baseUrl}.`);
}

function parseServerMessage(data: string): WebSocketServerMessage | null {
  try {
    const value = JSON.parse(data) as WebSocketServerMessage;
    return typeof value === "object" && value !== null && typeof value.type === "string" ? value : null;
  } catch {
    return null;
  }
}

function formatWireError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }

  return error === undefined ? "WebSocket stream error." : JSON.stringify(error);
}
