/**
 * Bun gateway for app.beeblast.co. It proxies normal HTTP/SSE requests to core
 * and adapts the public WebSocket endpoint to core's direct SSE API.
 */

import {
  type AgentStreamPart,
} from "../../../packages/filthy-panty/src/stream.ts";
import { resolveRunEvents } from "../../../packages/filthy-panty/src/run-input.ts";
import type {
  WebSocketClientExecuteMessage,
  WebSocketClientMessage,
  WebSocketServerMessage,
} from "../../../packages/filthy-panty/src/websocket-contracts.ts";
import {
  connectNats,
  readConversationStream,
  type NatsConnection,
  type NatsStreamEvent,
} from "../../core/functions/_shared/nats.ts";

type GatewayData = {
  corePath: string;
  token: string;
};

type GatewayServerOptions = {
  coreBaseUrl: string;
  port?: number;
  host?: string;
};

type ActiveRun = {
  abort: AbortController;
};

const decoder = new TextDecoder();
const activeRuns = new WeakMap<Bun.ServerWebSocket<GatewayData>, ActiveRun>();
let natsConnectionPromise: Promise<NatsConnection> | null = null;

export function createGatewayServer(options: GatewayServerOptions): Bun.Server<GatewayData> {
  const coreBaseUrl = normalizeBaseUrl(options.coreBaseUrl);

  return Bun.serve<GatewayData>({
    port: options.port ?? Number(process.env.PORT ?? "3000"),
    hostname: options.host ?? process.env.BIND_HOST ?? process.env.HOSTNAME ?? "0.0.0.0",
    idleTimeout: 255,
    fetch(request, server) {
      const url = new URL(request.url);

      if (url.pathname === "/" || url.pathname === "/healthz") {
        return json({ status: "ok", coreBaseUrl });
      }

      if (isWebSocketRequest(request) && isWebSocketPath(url.pathname)) {
        const token = bearerToken(request.headers.get("authorization")) ?? url.searchParams.get("token") ?? "";
        if (!token.trim()) {
          return json({ error: "Missing WebSocket token" }, { status: 401 });
        }

        const upgraded = server.upgrade(request, {
          data: {
            corePath: url.pathname.slice(0, -"/ws".length),
            token: token.trim(),
          },
        });

        return upgraded ? undefined : json({ error: "WebSocket upgrade failed" }, { status: 400 });
      }

      return proxyHttp(request, coreBaseUrl);
    },
    websocket: {
      async message(socket, rawMessage) {
        const message = parseGatewayMessage(rawMessage);
        if (!message) {
          send(socket, { type: "error", error: "Invalid WebSocket message" });
          socket.close(1003, "invalid message");
          return;
        }

        if (message.type === "cancel") {
          activeRuns.get(socket)?.abort.abort();
          activeRuns.delete(socket);
          return;
        }

        if (activeRuns.has(socket)) {
          send(socket, { type: "error", error: "A run is already active on this WebSocket" });
          return;
        }

        await runCoreStream(socket, coreBaseUrl, message);
      },
      close(socket) {
        activeRuns.get(socket)?.abort.abort();
        activeRuns.delete(socket);
      },
    },
  });
}

export function buildCoreRunBody(message: ExecuteMessage): Record<string, unknown> {
  const eventId = typeof message.eventId === "string" && message.eventId.trim()
    ? message.eventId.trim()
    : `ws-${Date.now()}-${crypto.randomUUID()}`;
  const conversationKey = typeof message.sessionId === "string" && message.sessionId.trim()
    ? message.sessionId.trim()
    : eventId;

  return {
    agentId: message.agentId.trim(),
    eventId,
    conversationKey,
    connectionId: `ws-${crypto.randomUUID()}`,
    events: resolveRunEvents(message),
    ...(message.system !== undefined ? { system: message.system } : {}),
    ...(message.model !== undefined ? { model: message.model } : {}),
  };
}

export function websocketMessageForStreamPart(part: AgentStreamPart): WebSocketServerMessage | null {
  if (!part || typeof part !== "object") {
    return null;
  }

  if (part.type === "text-delta") {
    return { type: "continuation_delta", delta: part.text };
  }
  if (part.type === "error") {
    return { type: "error", error: formatStreamError(part.error) };
  }
  if (part.type === "structured-output") {
    return { type: "sse", chunk: JSON.stringify(part) };
  }
  if (part.type === "tool-approval-request") {
    return { type: "sse", chunk: JSON.stringify(part) };
  }

  return null;
}

type ExecuteMessage = WebSocketClientExecuteMessage;
type NatsStartResponse = {
  eventId: string;
  conversationKey: string;
  nats: {
    accountId: string;
    agentId: string;
    conversationKey: string;
  };
};

async function runCoreStream(
  socket: Bun.ServerWebSocket<GatewayData>,
  coreBaseUrl: string,
  message: ExecuteMessage,
): Promise<void> {
  const abort = new AbortController();
  activeRuns.set(socket, { abort });

  let body: Record<string, unknown>;
  try {
    body = buildCoreRunBody(message);
  } catch (error) {
    send(socket, { type: "error", error: errorMessage(error) });
    activeRuns.delete(socket);
    return;
  }

  send(socket, {
    type: "meta",
    sessionId: String(body.conversationKey),
    taskId: String(body.eventId),
  });

  try {
    const response = await fetch(`${coreBaseUrl}${socket.data.corePath}`, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${socket.data.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: abort.signal,
    });

    if (!response.ok) {
      send(socket, {
        type: "error",
        status: response.status,
        error: await response.text(),
      });
      return;
    }

    const started = await response.json() as NatsStartResponse;
    await streamNatsResponses(socket, started, abort.signal);
  } catch (error) {
    if (!abort.signal.aborted) {
      send(socket, { type: "error", error: errorMessage(error) });
    }
  } finally {
    activeRuns.delete(socket);
  }
}

async function proxyHttp(request: Request, coreBaseUrl: string): Promise<Response> {
  const url = new URL(request.url);
  const target = `${coreBaseUrl}${url.pathname}${url.search}`;
  const headers = new Headers(request.headers);
  headers.delete("host");

  return fetch(target, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
  });
}

async function streamNatsResponses(
  socket: Bun.ServerWebSocket<GatewayData>,
  started: NatsStartResponse,
  signal: AbortSignal,
): Promise<void> {
  const connection = await getNatsConnection();
  const messages = await readConversationStream({
    connection,
    accountId: started.nats.accountId,
    agentId: started.nats.agentId,
    conversationKey: started.nats.conversationKey,
  });

  try {
    for await (const message of messages) {
      if (signal.aborted) {
        break;
      }

      const event = decodeNatsStreamEvent(message.data);
      if (!event) {
        ackNatsMessage(message);
        continue;
      }

      const outbound = websocketMessageForNatsData(event.data);
      if (outbound) {
        send(socket, outbound);
      }
      ackNatsMessage(message);

      if (event.data.type === "done") {
        break;
      }
    }
  } finally {
    await messages.close().catch(() => {});
  }
}

function websocketMessageForNatsData(data: Record<string, unknown>): WebSocketServerMessage | null {
  if (data.type === "done") {
    return { type: "done" };
  }
  if (data.type === "waiting") {
    return { type: "sse", chunk: JSON.stringify(data) };
  }
  if (data.type === "tool-approval-request") {
    return { type: "sse", chunk: JSON.stringify(data) };
  }

  return websocketMessageForStreamPart(data as AgentStreamPart);
}

function decodeNatsStreamEvent(data: Uint8Array): NatsStreamEvent | null {
  const parsed = parseJson(decoder.decode(data));

  return parsed && typeof parsed === "object" && (parsed as { type?: unknown }).type === "stream"
    ? parsed as NatsStreamEvent
    : null;
}

function ackNatsMessage(message: { ack?: () => void }): void {
  try {
    message.ack?.();
  } catch {
    // Ack is best-effort for ordered/ephemeral consumers.
  }
}

function getNatsConnection(): Promise<NatsConnection> {
  if (!natsConnectionPromise) {
    const natsUrl = process.env.NATS_URL?.trim();
    if (!natsUrl) {
      throw new Error("Gateway requires NATS_URL");
    }
    natsConnectionPromise = connectNats({
      servers: natsUrl,
      token: process.env.NATS_TOKEN?.trim() || undefined,
    }).catch((error) => {
      natsConnectionPromise = null;
      throw error;
    });
  }

  return natsConnectionPromise;
}

function parseGatewayMessage(rawMessage: string | Buffer): WebSocketClientMessage | null {
  const text = typeof rawMessage === "string" ? rawMessage : decoder.decode(rawMessage);
  const parsed = parseJson(text);

  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  if ((parsed as { type?: unknown }).type === "cancel") {
    return { type: "cancel" };
  }

  return isExecuteMessage(parsed)
    ? parsed
    : null;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function send(socket: Bun.ServerWebSocket<GatewayData>, payload: WebSocketServerMessage): void {
  socket.send(JSON.stringify(payload));
}

function json(payload: Record<string, unknown>, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("Gateway requires FILTHY_PANTY_CORE_URL");
  }

  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function bearerToken(value: string | null): string | null {
  const match = value?.match(/^Bearer\s+(.+)$/i);

  return match?.[1]?.trim() || null;
}

function isWebSocketRequest(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function isWebSocketPath(pathname: string): boolean {
  return /^\/v1\/agents\/[^/]+\/ws$/.test(pathname) ||
    /^\/v1\/[^/]+\/agents\/[^/]+\/[^/]+\/ws$/.test(pathname);
}

function isExecuteMessage(value: object): value is WebSocketClientExecuteMessage {
  const record = value as { type?: unknown; agentId?: unknown };

  return record.type === "execute" &&
    typeof record.agentId === "string" &&
    record.agentId.trim().length > 0;
}

function formatStreamError(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }

  return JSON.stringify(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  const coreBaseUrl = process.env.FILTHY_PANTY_CORE_URL ?? process.env.FILTHY_PANTY_BASE_URL ?? "";
  const server = createGatewayServer({ coreBaseUrl });
  process.stdout.write(`gateway listening on ${server.hostname}:${server.port}\n`);
}
