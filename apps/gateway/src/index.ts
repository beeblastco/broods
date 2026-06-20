/**
 * Bun gateway for public app traffic. It forwards normal HTTP requests to core
 * and adapts public WebSocket clients to core's NATS-backed stream.
 *
 * Two WS modes coexist — never mixed on the same socket:
 *   agent-test  /v1/agents/<id>/ws  and  /v1/<project>/agents/<env>/<endpointId>/ws
 *   observability  /v1/<project>/<env>/observability/ws
 */

import { resolveRunEvents } from "../../../packages/filthy-panty/src/run-input.ts";
import type {
  WebSocketClientExecuteMessage,
  WebSocketClientMessage,
  WebSocketServerMessage,
} from "../../../packages/filthy-panty/src/websocket-contracts.ts";
import {
  isObservabilityClientMessage,
  type ObservabilityClientMessage,
  type ObservabilityLogEntry,
  type ObservabilityServerMessage,
  type ObservabilitySpanRow,
  type LogLevel,
} from "../../../packages/filthy-panty/src/observability-contracts.ts";
import {
  connectNats,
  readConversationStream,
  logsSubjectWildcard,
  tracesSubjectWildcard,
  type NatsConnection,
  type NatsStreamEvent,
} from "../../core/functions/_shared/nats.ts";

// Typed socket data — agent-test vs observability are fully separate.
type AgentTestGatewayData = {
  kind: "agent-test";
  corePath: string;
  token: string;
  coreBaseUrl: string;
};

type ObservabilityGatewayData = {
  kind: "observability";
  project: string;
  env: string;
  token: string;
  scope: ObservabilityScope;
};

type GatewayData = AgentTestGatewayData | ObservabilityGatewayData;

// Observability scope returned by POST /v1/internal/observability-scope.
type ObservabilityScope = {
  accountId: string;
  projectSlug: string;
  environmentSlug: string;
  endpointIds: string[];
};

type NatsSubscription = { unsubscribe(): void };

type ObservabilitySocketState = {
  scope: ObservabilityScope;
  logsSub: NatsSubscription | null;
  tracesSub: NatsSubscription | null;
  logsMinLevel: LogLevel;
  logsBuffer: ObservabilityLogEntry[] | null;
  tracesBuffer: ObservabilitySpanRow[] | null;
};

type GatewayServerOptions = {
  coreBaseUrls: string[];
  port?: number;
  host?: string;
  limits?: GatewayLimits;
};

type ActiveRun = {
  abort: AbortController;
  startTimeout: ReturnType<typeof setTimeout>;
};

type GatewayLimits = {
  maxConnections: number;
  maxPayloadBytes: number;
  backpressureBytes: number;
  idleTimeoutSeconds: number;
  runStartTimeoutMs: number;
};

const decoder = new TextDecoder();
const activeRuns = new WeakMap<Bun.ServerWebSocket<GatewayData>, ActiveRun>();
const obsState = new WeakMap<Bun.ServerWebSocket<GatewayData>, ObservabilitySocketState>();
let natsConnectionPromise: Promise<NatsConnection> | null = null;
let activeSocketCount = 0;
const maxBunIdleTimeoutSeconds = 255;

// Level ordering used for minLevel filtering (NATS live stream).
const LOG_LEVEL_ORDER: Record<LogLevel, number> = { INFO: 0, WARN: 1, ERROR: 2 };

export function createGatewayServer(options: GatewayServerOptions): Bun.Server<GatewayData> {
  const coreBaseUrls = normalizedCoreBaseUrls(options.coreBaseUrls);
  const limits = options.limits ?? gatewayLimitsFromEnv();

  return Bun.serve<GatewayData>({
    port: options.port ?? Number(process.env.PORT ?? "3000"),
    hostname: options.host ?? process.env.BIND_HOST ?? process.env.HOSTNAME ?? "0.0.0.0",
    idleTimeout: limits.idleTimeoutSeconds,
    async fetch(request, server) {
      const url = new URL(request.url);

      if (url.pathname === "/" || url.pathname === "/healthz") {
        return json({
          status: "ok",
          activeWebSockets: activeSocketCount,
          maxWebSockets: limits.maxConnections,
        });
      }

      if (isWebSocketRequest(request)) {
        if (isObservabilityWebSocketPath(url.pathname)) {
          if (activeSocketCount >= limits.maxConnections) {
            return json({ error: "Gateway is at capacity" }, { status: 503 });
          }

          const token = bearerToken(request.headers.get("authorization")) ?? url.searchParams.get("token") ?? "";
          if (!token.trim()) {
            return json({ error: "Missing WebSocket token" }, { status: 401 });
          }

          // Extract <project> and <env> from /v1/<project>/<env>/observability/ws
          const obsMatch = url.pathname.match(/^\/v1\/([^/]+)\/([^/]+)\/observability\/ws$/);
          if (!obsMatch) {
            return json({ error: "Invalid observability WebSocket path" }, { status: 400 });
          }

          const resolved = await resolveObservabilityScope(token.trim(), coreBaseUrls);
          if (!resolved) {
            return json({ error: "Invalid WebSocket token" }, { status: 401 });
          }
          if (
            resolved.scope.projectSlug !== decodeURIComponent(obsMatch[1]) ||
            resolved.scope.environmentSlug !== decodeURIComponent(obsMatch[2])
          ) {
            return json({ error: "WebSocket scope does not match the requested project/environment" }, { status: 403 });
          }

          const upgraded = server.upgrade(request, {
            data: {
              kind: "observability",
              project: obsMatch[1],
              env: obsMatch[2],
              token: token.trim(),
              scope: resolved.scope,
            } satisfies ObservabilityGatewayData,
          });

          return upgraded ? undefined : json({ error: "WebSocket upgrade failed" }, { status: 400 });
        }

        if (isWebSocketPath(url.pathname)) {
          if (activeSocketCount >= limits.maxConnections) {
            return json({ error: "Gateway is at capacity" }, { status: 503 });
          }

          const token = bearerToken(request.headers.get("authorization")) ?? url.searchParams.get("token") ?? "";
          if (!token.trim()) {
            return json({ error: "Missing WebSocket token" }, { status: 401 });
          }

          const resolved = await resolveObservabilityScope(token.trim(), coreBaseUrls);
          if (!resolved) {
            return json({ error: "Invalid WebSocket token" }, { status: 401 });
          }

          const upgraded = server.upgrade(request, {
            data: {
              kind: "agent-test",
              corePath: url.pathname.slice(0, -"/ws".length),
              token: token.trim(),
              coreBaseUrl: resolved.coreBaseUrl,
            } satisfies AgentTestGatewayData,
          });

          return upgraded ? undefined : json({ error: "WebSocket upgrade failed" }, { status: 400 });
        }
      }

      if (!isCoreHttpPath(url.pathname)) {
        return json({ error: "Not found" }, { status: 404 });
      }

      return proxyHttp(request, coreBaseUrls);
    },
    websocket: {
      maxPayloadLength: limits.maxPayloadBytes,
      backpressureLimit: limits.backpressureBytes,
      closeOnBackpressureLimit: true,
      idleTimeout: limits.idleTimeoutSeconds,
      open(socket) {
        activeSocketCount += 1;
        if (socket.data.kind === "observability") {
          obsState.set(socket, {
            scope: socket.data.scope,
            logsSub: null,
            tracesSub: null,
            logsMinLevel: "INFO",
            logsBuffer: null,
            tracesBuffer: null,
          });
        }
      },
      async message(socket, rawMessage) {
        if (socket.data.kind === "observability") {
          await handleObservabilityMessage(socket as Bun.ServerWebSocket<ObservabilityGatewayData>, rawMessage);
          return;
        }

        // Agent-test path (kind === "agent-test")
        const agentSocket = socket as Bun.ServerWebSocket<AgentTestGatewayData>;
        const message = parseGatewayMessage(rawMessage);
        if (!message) {
          send(agentSocket, { type: "error", error: "Invalid WebSocket message" });
          socket.close(1003, "invalid message");
          return;
        }

        if (message.type === "cancel") {
          activeRuns.get(agentSocket)?.abort.abort();
          activeRuns.delete(agentSocket);
          return;
        }

        if (activeRuns.has(agentSocket)) {
          send(agentSocket, { type: "error", error: "A run is already active on this WebSocket" });
          return;
        }

        void runCoreStream(agentSocket, message, limits);
      },
      close(socket) {
        activeSocketCount = Math.max(0, activeSocketCount - 1);
        if (socket.data.kind === "observability") {
          cleanupObservabilitySocket(socket as Bun.ServerWebSocket<ObservabilityGatewayData>);
          return;
        }
        const agentSocket = socket as Bun.ServerWebSocket<AgentTestGatewayData>;
        stopActiveRun(agentSocket);
        activeRuns.delete(agentSocket);
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
  socket: Bun.ServerWebSocket<AgentTestGatewayData>,
  message: ExecuteMessage,
  limits: GatewayLimits,
): Promise<void> {
  const abort = new AbortController();
  let startTimedOut = false;
  const startTimeout = setTimeout(() => {
    startTimedOut = true;
    abort.abort();
  }, limits.runStartTimeoutMs);
  activeRuns.set(socket, { abort, startTimeout });

  let body: Record<string, unknown>;
  try {
    body = buildCoreRunBody(message);
  } catch (error) {
    send(socket, { type: "error", error: errorMessage(error) });
    stopActiveRun(socket);
    return;
  }

  send(socket, {
    type: "meta",
    sessionId: String(body.conversationKey),
    taskId: String(body.eventId),
  });

  try {
    const response = await fetch(`${socket.data.coreBaseUrl}${socket.data.corePath}`, {
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
      clearTimeout(startTimeout);
      send(socket, {
        type: "error",
        status: response.status,
        error: await response.text(),
      });
      return;
    }

    const started = await response.json() as NatsStartResponse;
    clearTimeout(startTimeout);
    await streamNatsResponses(socket, started, abort.signal);
  } catch (error) {
    if (!abort.signal.aborted) {
      send(socket, { type: "error", error: errorMessage(error) });
    } else if (startTimedOut) {
      send(socket, { type: "error", error: "Run start timed out" });
    }
  } finally {
    stopActiveRun(socket);
  }
}

async function proxyHttp(request: Request, coreBaseUrls: string[]): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("upgrade");

  const body = request.method === "GET" || request.method === "HEAD"
    ? undefined
    : await request.arrayBuffer();
  let response: Response | null = null;
  for (const coreBaseUrl of coreBaseUrls) {
    response = await fetch(`${coreBaseUrl}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
    });
    if (response.status !== 401) return response;
  }

  return response ?? json({ error: "No core upstream is configured" }, { status: 503 });
}

async function streamNatsResponses(
  socket: Bun.ServerWebSocket<AgentTestGatewayData>,
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
        sendAgentTest(socket, outbound);
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

export function websocketMessageForNatsData(data: Record<string, unknown>): WebSocketServerMessage | null {
  return typeof data.type === "string" ? data as WebSocketServerMessage : null;
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

/** Send an agent-test protocol message. */
function sendAgentTest(socket: Bun.ServerWebSocket<AgentTestGatewayData>, payload: WebSocketServerMessage): void {
  socket.send(JSON.stringify(payload));
}

/** Send an observability protocol message. */
function sendObs(socket: Bun.ServerWebSocket<ObservabilityGatewayData>, payload: ObservabilityServerMessage): void {
  socket.send(JSON.stringify(payload));
}

// Short alias used throughout runCoreStream.
const send = sendAgentTest;

function stopActiveRun(socket: Bun.ServerWebSocket<AgentTestGatewayData>): void {
  const activeRun = activeRuns.get(socket);
  if (!activeRun) return;
  clearTimeout(activeRun.startTimeout);
  activeRun.abort.abort();
  activeRuns.delete(socket);
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
    throw new Error("Gateway requires FILTHY_PANTY_CORE_URLS");
  }

  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** Normalize, de-duplicate, and require at least one core upstream URL. */
export function normalizedCoreBaseUrls(values: string[]): string[] {
  const urls = [...new Set(values.map((value) => value.trim()).filter(Boolean).map(normalizeBaseUrl))];
  if (urls.length === 0) throw new Error("Gateway requires FILTHY_PANTY_CORE_URLS");

  return urls;
}

function bearerToken(value: string | null): string | null {
  const match = value?.match(/^Bearer\s+(.+)$/i);

  return match?.[1]?.trim() || null;
}

type ResolvedObservabilityScope = {
  scope: ObservabilityScope;
  coreBaseUrl: string;
};
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// Validate the bearer token against each configured core. The matched upstream
// is retained for stage-correct agent execution while one public gateway serves
// both dev and production.
export async function resolveObservabilityScope(
  token: string,
  coreBaseUrls: string[],
  fetchImpl: FetchLike = fetch,
): Promise<ResolvedObservabilityScope | null> {
  for (const coreBaseUrl of coreBaseUrls) {
    try {
      const response = await fetchImpl(`${coreBaseUrl}/v1/internal/observability-scope`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) continue;

      return { scope: await response.json() as ObservabilityScope, coreBaseUrl };
    } catch {
      continue;
    }
  }

  return null;
}

/** Dispatch an incoming message for an observability socket. */
async function handleObservabilityMessage(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
  rawMessage: string | Buffer,
): Promise<void> {
  const text = typeof rawMessage === "string" ? rawMessage : decoder.decode(rawMessage);
  const parsed = parseJson(text);

  if (!isObservabilityClientMessage(parsed as unknown)) {
    sendObs(socket, { type: "error", error: "Invalid observability message" });
    return;
  }

  const msg = parsed as ObservabilityClientMessage;

  const scope = socket.data.scope;

  if (msg.type === "unsubscribe") {
    cleanupObservabilityStream(socket, msg.stream);
    return;
  }

  // subscribe
  await handleObservabilitySubscribe(socket, scope, msg.stream, msg.backfill, msg.minLevel ?? "INFO");
}

async function handleObservabilitySubscribe(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
  scope: ObservabilityScope,
  stream: "logs" | "traces",
  backfill: number | undefined,
  minLevel: LogLevel,
): Promise<void> {
  const state = obsState.get(socket as Bun.ServerWebSocket<GatewayData>);
  if (!state) return;

  cleanupObservabilityStream(socket, stream);

  // Update minLevel for live filtering (logs only).
  if (stream === "logs") {
    state.logsMinLevel = minLevel;
    state.logsBuffer = typeof backfill === "number" && backfill > 0 ? [] : null;
  } else {
    state.tracesBuffer = typeof backfill === "number" && backfill > 0 ? [] : null;
  }

  // Subscribe first so events emitted during the durable query cannot fall into
  // a backfill/live handoff gap. Clients de-duplicate any overlap.
  const live = await startLiveSubscription(socket, scope, stream, state);
  if (!live) {
    sendObs(socket, { type: "error", error: "Live observability transport is unavailable." });
    return;
  }

  if (typeof backfill === "number" && backfill > 0) {
    const backfilled = await sendBackfill(socket, scope, stream, backfill);
    if (!backfilled) {
      cleanupObservabilityStream(socket, stream);
      sendObs(socket, { type: "error", error: `Durable ${stream} backfill is unavailable.` });
      return;
    }
    flushLiveBuffer(socket, stream, state);
  }

  sendObs(socket, { type: "ready" });
}

/** Query Loki or Tempo and send a backfill message. Best-effort — skip on missing env. */
async function sendBackfill(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
  scope: ObservabilityScope,
  stream: "logs" | "traces",
  limit: number,
): Promise<boolean> {
  try {
    if (stream === "logs") {
      const lokiUrl = process.env.LOKI_URL?.trim();
      if (!lokiUrl) return false;
      const entries = await fetchLokiBackfill(lokiUrl, scope, limit);
      sendObs(socket, { type: "backfill", stream: "logs", entries });
    } else {
      const tempoUrl = process.env.TEMPO_URL?.trim();
      if (!tempoUrl) return false;
      const entries = await fetchTempoBackfill(tempoUrl, scope, limit);
      sendObs(socket, { type: "backfill", stream: "traces", entries });
    }
    return true;
  } catch {
    return false;
  }
}

// Selectors are built only from server-validated scope, never raw client input.
async function fetchLokiBackfill(
  lokiUrl: string,
  scope: ObservabilityScope,
  limit: number,
): Promise<ObservabilityLogEntry[]> {
  const selector = `{account_id="${scope.accountId}",project="${scope.projectSlug}",environment="${scope.environmentSlug}"}`;
  const url = new URL(`${lokiUrl}/loki/api/v1/query_range`);
  url.searchParams.set("query", selector);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("direction", "backward");

  const response = await fetch(url.toString(), { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Loki query failed with HTTP ${response.status}`);

  const body = await response.json() as {
    data?: { result?: Array<{ stream: Record<string, string>; values: Array<[string, string]> }> };
  };

  const result = body?.data?.result ?? [];
  const entries: ObservabilityLogEntry[] = [];

  for (const stream of result) {
    for (const [nsStr, line] of stream.values) {
      const tsMs = Math.floor(Number(nsStr) / 1_000_000);
      entries.push(lokiLogEntry(stream.stream, line, tsMs, scope.accountId));
    }
  }

  // Return chronological order (Loki returns newest-first with direction=backward).
  return entries.reverse();
}

/** Rehydrate one Loki OTLP line with the structured metadata returned beside it. */
export function lokiLogEntry(
  metadata: Record<string, string>,
  line: string,
  fallbackTs: number,
  fallbackAccountId: string,
): ObservabilityLogEntry {
  const parsed = parseJson(line);
  const record = parsed && typeof parsed === "object"
    ? parsed as Record<string, unknown>
    : {};
  const rawLevel = record.level ?? metadata.level ?? metadata.severity_text ?? metadata.detected_level;
  const level = rawLevel === "DEBUG" || rawLevel === "WARN" || rawLevel === "ERROR"
    ? rawLevel
    : "INFO";
  const parsedTime = typeof record.ts === "number"
    ? record.ts
    : typeof record.time === "string"
      ? Date.parse(record.time)
      : Number.NaN;

  return {
    ts: Number.isFinite(parsedTime) ? parsedTime : fallbackTs,
    level,
    eventType: stringValue(record.eventType, metadata.eventType, "log"),
    message: stringValue(record.message, metadata.message, line),
    traceId: optionalString(record.traceId, metadata.traceId, metadata.trace_id),
    accountId: optionalString(record.accountId, metadata.accountId, metadata.account_id) ?? fallbackAccountId,
    endpointId: optionalString(record.endpointId, metadata.endpointId, metadata.endpoint_id),
    agentId: optionalString(record.agentId, metadata.agentId, metadata.agent_id),
    conversationKey: optionalString(record.conversationKey, metadata.conversationKey, metadata.conversation_key),
    service: optionalString(record.service, metadata.service, metadata.service_name),
    data: Object.keys(record).length > 0 ? record : metadata,
  };
}

function optionalString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function stringValue(...values: unknown[]): string {
  return optionalString(...values) ?? "";
}

// Tag filters are built only from server-validated scope.
async function fetchTempoBackfill(
  tempoUrl: string,
  scope: ObservabilityScope,
  limit: number,
): Promise<ObservabilitySpanRow[]> {
  const url = new URL(`${tempoUrl}/api/search`);
  const end = Math.floor(Date.now() / 1_000);
  const start = end - 90 * 24 * 60 * 60;
  url.searchParams.set("tags", `account_id=${scope.accountId} project=${scope.projectSlug} environment=${scope.environmentSlug}`);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("start", String(start));
  url.searchParams.set("end", String(end));

  const response = await fetch(url.toString(), { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Tempo search failed with HTTP ${response.status}`);

  const body = await response.json() as {
    traces?: Array<{
      traceID: string;
      rootSpanName?: string;
      rootTraceName?: string;
      startTimeUnixNano?: string;
      durationMs?: number;
    }>;
  };

  const traces = body?.traces ?? [];
  const rows = await Promise.allSettled(traces.map(async (traceSummary) => {
    const detailResponse = await fetch(
      `${tempoUrl}/api/traces/${encodeURIComponent(traceSummary.traceID)}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!detailResponse.ok) throw new Error(`Tempo trace query failed with HTTP ${detailResponse.status}`);

    return tempoTraceRowsFromResponse(await detailResponse.json(), traceSummary.traceID);
  }));

  return rows
    .flatMap((result) => result.status === "fulfilled" ? result.value : [])
    .sort((a, b) => b.startTimeMs - a.startTimeMs);
}

type OtelValue = {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: OtelValue[] };
};

type OtelAttribute = { key?: string; value?: OtelValue };

function otelValue(value: OtelValue | undefined): unknown {
  if (!value) return undefined;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(otelValue);
  return undefined;
}

function otelAttributes(attributes: OtelAttribute[] | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const attribute of attributes ?? []) {
    if (!attribute.key) continue;
    result[attribute.key] = otelValue(attribute.value);
  }

  return result;
}

/** Convert Tempo's OTLP trace-detail response into the dashboard's full span tree. */
export function tempoTraceRowsFromResponse(payload: unknown, fallbackTraceId = ""): ObservabilitySpanRow[] {
  const batches = (payload as {
    batches?: Array<{
      resource?: { attributes?: OtelAttribute[] };
      scopeSpans?: Array<{ spans?: Array<Record<string, unknown>> }>;
      instrumentationLibrarySpans?: Array<{ spans?: Array<Record<string, unknown>> }>;
    }>;
  })?.batches ?? [];
  const rows: ObservabilitySpanRow[] = [];

  for (const batch of batches) {
    const resourceAttributes = otelAttributes(batch.resource?.attributes);
    const groups = batch.scopeSpans ?? batch.instrumentationLibrarySpans ?? [];
    for (const group of groups) {
      for (const raw of group.spans ?? []) {
        const attributes = { ...resourceAttributes, ...otelAttributes(raw.attributes as OtelAttribute[] | undefined) };
        const traceId = typeof raw.traceId === "string" ? raw.traceId : fallbackTraceId;
        const spanId = typeof raw.spanId === "string" ? raw.spanId : "";
        if (!traceId || !spanId) continue;
        const startTimeMs = Math.floor(Number(raw.startTimeUnixNano ?? 0) / 1_000_000);
        const endTimeMs = Math.floor(Number(raw.endTimeUnixNano ?? raw.startTimeUnixNano ?? 0) / 1_000_000);
        const name = typeof raw.name === "string" ? raw.name : "agent.task";
        const status = raw.status as { code?: unknown; message?: unknown } | undefined;
        const isError = status?.code === 2 || status?.code === "STATUS_CODE_ERROR";
        rows.push({
          traceId,
          spanId,
          ...(typeof raw.parentSpanId === "string" && raw.parentSpanId ? { parentSpanId: raw.parentSpanId } : {}),
          name,
          kind: name === "model.step" ? "model.step" : name === "tool.call" ? "tool.call" : "task",
          startTimeMs,
          endTimeMs,
          durationMs: Math.max(0, endTimeMs - startTimeMs),
          status: isError ? "error" : "ok",
          ...(typeof attributes.endpoint_id === "string" ? { endpointId: attributes.endpoint_id } : {}),
          ...(typeof attributes.agent_id === "string" ? { agentId: attributes.agent_id } : {}),
          ...(typeof attributes.conversation_key === "string" ? { conversationKey: attributes.conversation_key } : {}),
          attributes,
          ...(isError && typeof status?.message === "string" ? { error: status.message } : {}),
        });
      }
    }
  }

  return rows;
}

/** Start a core NATS subscribe (NOT JetStream) for logs or traces. */
async function startLiveSubscription(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
  scope: ObservabilityScope,
  stream: "logs" | "traces",
  state: ObservabilitySocketState,
): Promise<boolean> {
  try {
    const connection = await getNatsConnection();
    const subject = stream === "logs"
      ? logsSubjectWildcard(scope.accountId, scope.projectSlug, scope.environmentSlug)
      : tracesSubjectWildcard(scope.accountId, scope.projectSlug, scope.environmentSlug);

    const sub = connection.subscribe(subject);
    const natsSub: NatsSubscription = { unsubscribe: () => sub.unsubscribe() };

    if (stream === "logs") {
      state.logsSub = natsSub;
    } else {
      state.tracesSub = natsSub;
    }

    // Relay NATS messages in the background — non-blocking.
    void relayNatsMessages(socket, sub, stream, state);
    return true;
  } catch {
    return false;
  }
}

/** Decode and relay NATS messages to the client WS. */
async function relayNatsMessages(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
  sub: { [Symbol.asyncIterator](): AsyncIterator<{ data: Uint8Array }> },
  stream: "logs" | "traces",
  state: ObservabilitySocketState,
): Promise<void> {
  try {
    for await (const msg of sub) {
      const text = decoder.decode(msg.data);
      const parsed = parseJson(text);
      if (!parsed || typeof parsed !== "object") continue;

      if (stream === "logs") {
        const entry = parsed as ObservabilityLogEntry;
        const entryLevel = (entry.level as string) as LogLevel;
        if (LOG_LEVEL_ORDER[entryLevel] === undefined) continue;
        if (LOG_LEVEL_ORDER[entryLevel] < LOG_LEVEL_ORDER[state.logsMinLevel]) continue;
        if (state.logsBuffer) {
          state.logsBuffer.push(entry);
          continue;
        }
        sendObs(socket, { type: "log", entry });
      } else {
        const entry = parsed as ObservabilitySpanRow;
        if (state.tracesBuffer) {
          state.tracesBuffer.push(entry);
          continue;
        }
        sendObs(socket, { type: "span", entry });
      }
    }
  } catch {
    // Iterator closed (unsubscribe or socket close) — silent exit.
  }
}

function flushLiveBuffer(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
  stream: "logs" | "traces",
  state: ObservabilitySocketState,
): void {
  if (stream === "logs") {
    const buffered = state.logsBuffer ?? [];
    state.logsBuffer = null;
    for (const entry of buffered) sendObs(socket, { type: "log", entry });
    return;
  }
  const buffered = state.tracesBuffer ?? [];
  state.tracesBuffer = null;
  for (const entry of buffered) sendObs(socket, { type: "span", entry });
}

/** Tear down the NATS subscription for one stream. */
function cleanupObservabilityStream(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
  stream: "logs" | "traces",
): void {
  const state = obsState.get(socket as Bun.ServerWebSocket<GatewayData>);
  if (!state) return;
  if (stream === "logs") state.logsBuffer = null;
  else state.tracesBuffer = null;
  if (stream === "logs" && state.logsSub) {
    state.logsSub.unsubscribe();
    state.logsSub = null;
  } else if (stream === "traces" && state.tracesSub) {
    state.tracesSub.unsubscribe();
    state.tracesSub = null;
  }
}

/** Tear down all subscriptions for an observability socket on close. */
function cleanupObservabilitySocket(socket: Bun.ServerWebSocket<ObservabilityGatewayData>): void {
  cleanupObservabilityStream(socket, "logs");
  cleanupObservabilityStream(socket, "traces");
  obsState.delete(socket as Bun.ServerWebSocket<GatewayData>);
}

function isWebSocketRequest(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function isWebSocketPath(pathname: string): boolean {
  return /^\/v1\/agents\/[^/]+\/ws$/.test(pathname) ||
    /^\/v1\/[^/]+\/agents\/[^/]+\/[^/]+\/ws$/.test(pathname);
}

/** /v1/<project>/<env>/observability/ws */
export function isObservabilityWebSocketPath(pathname: string): boolean {
  return /^\/v1\/[^/]+\/[^/]+\/observability\/ws$/.test(pathname);
}

function isCoreHttpPath(pathname: string): boolean {
  return pathname === "/v1" || pathname.startsWith("/v1/");
}

function isExecuteMessage(value: object): value is WebSocketClientExecuteMessage {
  const record = value as { type?: unknown; agentId?: unknown };

  return record.type === "execute" &&
    typeof record.agentId === "string" &&
    record.agentId.trim().length > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function gatewayLimitsFromEnv(env: Record<string, string | undefined> = process.env): GatewayLimits {
  return {
    maxConnections: positiveInt(env.GATEWAY_MAX_CONNECTIONS, 10_000),
    maxPayloadBytes: positiveInt(env.GATEWAY_MAX_PAYLOAD_BYTES, 1024 * 1024),
    backpressureBytes: positiveInt(env.GATEWAY_BACKPRESSURE_BYTES, 1024 * 1024),
    idleTimeoutSeconds: Math.min(
      positiveInt(env.GATEWAY_IDLE_TIMEOUT_SECONDS, maxBunIdleTimeoutSeconds),
      maxBunIdleTimeoutSeconds,
    ),
    runStartTimeoutMs: positiveInt(env.GATEWAY_RUN_START_TIMEOUT_MS, 15_000),
  };
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

if (import.meta.main) {
  const configuredCoreUrls = process.env.FILTHY_PANTY_CORE_URLS?.split(",") ?? [];
  const server = createGatewayServer({ coreBaseUrls: configuredCoreUrls });
  process.stdout.write(`gateway listening on ${server.hostname}:${server.port}\n`);
}
