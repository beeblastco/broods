import {
  isObservabilityClientMessage,
  type LogLevel,
  type ObservabilityClientMessage,
  type ObservabilityLogEntry,
  type ObservabilityServerMessage,
  type ObservabilitySpanRow,
} from "../../../packages/broods/src/observability-contracts.ts";
import {
  readObservabilityStream,
  type NatsConnection,
} from "../../core/src/shared/nats.ts";
import { decoder, mapWithConcurrency, parseJson } from "./utils.ts";

export type ObservabilityScope = {
  accountId: string;
  projectSlug: string;
  environmentSlug: string;
  endpointIds: string[];
};

export type ObservabilityGatewayData = {
  kind: "observability";
  project: string;
  env: string;
  token: string;
  scope: ObservabilityScope;
};

type NatsSubscription = { unsubscribe(): void };
type ObservabilitySocketState = {
  scope: ObservabilityScope;
  logsSub: NatsSubscription | null;
  tracesSub: NatsSubscription | null;
  logsMinLevel: LogLevel;
};
type OtelValue = {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: OtelValue[] };
};
type OtelAttribute = { key?: string; value?: OtelValue };

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  INFO: 0,
  WARN: 1,
  ERROR: 2,
};
const LOKI_BACKFILL_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const OBS_REPLAY_WINDOW_MS = 30 * 60 * 1000;
const TEMPO_DETAIL_CONCURRENCY = 6;
const obsState = new WeakMap<
  Bun.ServerWebSocket<ObservabilityGatewayData>,
  ObservabilitySocketState
>();

export async function handleObservabilityMessage(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
  rawMessage: string | Buffer,
  getNatsConnection: () => Promise<NatsConnection>,
): Promise<void> {
  const text =
    typeof rawMessage === "string" ? rawMessage : decoder.decode(rawMessage);
  const parsed = parseJson(text);

  if (!isObservabilityClientMessage(parsed)) {
    sendObs(socket, { type: "error", error: "Invalid observability message" });
    return;
  }

  const msg = parsed as ObservabilityClientMessage;
  if (msg.type === "unsubscribe") {
    cleanupObservabilityStream(socket, msg.stream);
    return;
  }

  await handleObservabilitySubscribe(
    socket,
    socket.data.scope,
    msg.stream,
    msg.backfill,
    msg.liveOnly === true,
    msg.minLevel ?? "INFO",
    getNatsConnection,
  );
}

export async function relayNatsMessages(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
  sub: { [Symbol.asyncIterator](): AsyncIterator<{ data: Uint8Array }> },
  stream: "logs" | "traces",
  state: Pick<ObservabilitySocketState, "logsMinLevel">,
): Promise<void> {
  try {
    for await (const msg of sub) {
      try {
        const parsed = parseJson(decoder.decode(msg.data));
        if (!parsed || typeof parsed !== "object") continue;

        if (stream === "logs") {
          const entry = parsed as ObservabilityLogEntry;
          const entryLevel = entry.level as LogLevel;
          if (LOG_LEVEL_ORDER[entryLevel] === undefined) continue;
          if (LOG_LEVEL_ORDER[entryLevel] < LOG_LEVEL_ORDER[state.logsMinLevel])
            continue;
          sendObs(socket, { type: "log", entry });
        } else {
          sendObs(socket, {
            type: "span",
            entry: parsed as ObservabilitySpanRow,
          });
        }
      } catch {
        continue;
      }
    }
  } catch {
    return;
  }
}

export function openObservabilitySocket(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
): void {
  obsState.set(socket, {
    scope: socket.data.scope,
    logsSub: null,
    tracesSub: null,
    logsMinLevel: "INFO",
  });
}

export function cleanupObservabilitySocket(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
): void {
  cleanupObservabilityStream(socket, "logs");
  cleanupObservabilityStream(socket, "traces");
  obsState.delete(socket);
}

export function lokiLogEntry(
  metadata: Record<string, string>,
  line: string,
  fallbackTs: number,
  fallbackAccountId: string,
): ObservabilityLogEntry {
  const parsed = parseJson(line);
  const record =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  const rawLevel =
    record.level ??
    metadata.level ??
    metadata.severity_text ??
    metadata.detected_level;
  const level =
    rawLevel === "DEBUG" || rawLevel === "WARN" || rawLevel === "ERROR"
      ? rawLevel
      : "INFO";
  const parsedTime =
    typeof record.ts === "number"
      ? record.ts
      : typeof record.time === "string"
        ? Date.parse(record.time)
        : Number.NaN;

  return {
    ts: Number.isFinite(parsedTime) ? parsedTime : fallbackTs,
    level,
    eventType: stringValue(record.eventType, metadata.eventType, "log"),
    message: stringValue(record.message, metadata.message, line),
    traceId: optionalString(
      record.traceId,
      metadata.traceId,
      metadata.trace_id,
    ),
    accountId:
      optionalString(
        record.accountId,
        metadata.accountId,
        metadata.account_id,
      ) ?? fallbackAccountId,
    endpointId: optionalString(
      record.endpointId,
      metadata.endpointId,
      metadata.endpoint_id,
    ),
    agentId: optionalString(
      record.agentId,
      metadata.agentId,
      metadata.agent_id,
    ),
    conversationKey: optionalString(
      record.conversationKey,
      metadata.conversationKey,
      metadata.conversation_key,
    ),
    service: optionalString(
      record.service,
      metadata.service,
      metadata.service_name,
    ),
    data: Object.keys(record).length > 0 ? record : metadata,
  };
}

export function normalizeOtelId(value: unknown, byteLength: number): string {
  if (typeof value !== "string" || value.length === 0) return "";
  if (value.length === byteLength * 2 && /^[0-9a-f]+$/.test(value))
    return value;

  try {
    const bytes = Buffer.from(
      value.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    );
    if (bytes.length === byteLength) return bytes.toString("hex");
  } catch {
    return value;
  }

  return value;
}

export function tempoTraceRowsFromResponse(
  payload: unknown,
  fallbackTraceId = "",
): ObservabilitySpanRow[] {
  const batches =
    (
      payload as {
        batches?: Array<{
          resource?: { attributes?: OtelAttribute[] };
          scopeSpans?: Array<{ spans?: Array<Record<string, unknown>> }>;
          instrumentationLibrarySpans?: Array<{
            spans?: Array<Record<string, unknown>>;
          }>;
        }>;
      }
    )?.batches ?? [];
  const rows: ObservabilitySpanRow[] = [];

  for (const batch of batches) {
    const resourceAttributes = otelAttributes(batch.resource?.attributes);
    const groups = batch.scopeSpans ?? batch.instrumentationLibrarySpans ?? [];

    for (const group of groups) {
      for (const raw of group.spans ?? []) {
        const attributes = {
          ...resourceAttributes,
          ...otelAttributes(raw.attributes as OtelAttribute[] | undefined),
        };
        const traceId = normalizeOtelId(raw.traceId, 16) || fallbackTraceId;
        const spanId = normalizeOtelId(raw.spanId, 8);
        const parentSpanId = normalizeOtelId(raw.parentSpanId, 8);
        if (!traceId || !spanId) continue;

        const startTimeMs = Math.floor(
          Number(raw.startTimeUnixNano ?? 0) / 1_000_000,
        );
        const endTimeMs = Math.floor(
          Number(raw.endTimeUnixNano ?? raw.startTimeUnixNano ?? 0) / 1_000_000,
        );
        const name = typeof raw.name === "string" ? raw.name : "agent.task";
        const status = raw.status as
          { code?: unknown; message?: unknown } | undefined;
        const isError =
          status?.code === 2 || status?.code === "STATUS_CODE_ERROR";

        rows.push({
          traceId,
          spanId,
          ...(parentSpanId ? { parentSpanId } : {}),
          name,
          kind: spanKind(name),
          startTimeMs,
          endTimeMs,
          durationMs: Math.max(0, endTimeMs - startTimeMs),
          status: isError ? "error" : "ok",
          ...(typeof attributes.endpoint_id === "string"
            ? { endpointId: attributes.endpoint_id }
            : {}),
          ...(typeof attributes.agent_id === "string"
            ? { agentId: attributes.agent_id }
            : {}),
          ...(typeof attributes.conversation_key === "string"
            ? { conversationKey: attributes.conversation_key }
            : {}),
          attributes,
          ...(isError && typeof status?.message === "string"
            ? { error: status.message }
            : {}),
        });
      }
    }
  }

  return rows;
}

async function handleObservabilitySubscribe(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
  scope: ObservabilityScope,
  stream: "logs" | "traces",
  backfill: number | undefined,
  liveOnly: boolean,
  minLevel: LogLevel,
  getNatsConnection: () => Promise<NatsConnection>,
): Promise<void> {
  const state = obsState.get(socket);
  if (!state) return;

  cleanupObservabilityStream(socket, stream);
  if (stream === "logs") state.logsMinLevel = minLevel;

  const live = await startLiveSubscription(
    socket,
    scope,
    stream,
    state,
    liveOnly,
    getNatsConnection,
  );
  if (!live) {
    sendObs(socket, {
      type: "error",
      error: "Live observability transport is unavailable.",
    });
    return;
  }

  sendObs(socket, { type: "ready" });
  if (typeof backfill === "number" && backfill > 0)
    void sendBackfill(socket, scope, stream, backfill);
}

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
      sendObs(socket, {
        type: "backfill",
        stream: "logs",
        entries: await fetchLokiBackfill(lokiUrl, scope, limit),
      });
    } else {
      const tempoUrl = process.env.TEMPO_URL?.trim();
      if (!tempoUrl) return false;
      sendObs(socket, {
        type: "backfill",
        stream: "traces",
        entries: await fetchTempoBackfill(tempoUrl, scope, limit),
      });
    }
    return true;
  } catch {
    return false;
  }
}

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
  url.searchParams.set(
    "start",
    new Date(Date.now() - LOKI_BACKFILL_WINDOW_MS).toISOString(),
  );
  url.searchParams.set("end", new Date().toISOString());

  const response = await fetch(url.toString(), {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok)
    throw new Error(`Loki query failed with HTTP ${response.status}`);

  const body = (await response.json()) as {
    data?: {
      result?: Array<{
        stream: Record<string, string>;
        values: Array<[string, string]>;
      }>;
    };
  };
  const entries: ObservabilityLogEntry[] = [];

  for (const stream of body?.data?.result ?? []) {
    for (const [nsStr, line] of stream.values) {
      entries.push(
        lokiLogEntry(
          stream.stream,
          line,
          Math.floor(Number(nsStr) / 1_000_000),
          scope.accountId,
        ),
      );
    }
  }

  return entries.reverse();
}

async function fetchTempoBackfill(
  tempoUrl: string,
  scope: ObservabilityScope,
  limit: number,
): Promise<ObservabilitySpanRow[]> {
  const url = new URL(`${tempoUrl}/api/search`);
  const end = Math.floor(Date.now() / 1_000);
  const start = end - 90 * 24 * 60 * 60;
  url.searchParams.set(
    "tags",
    `account_id=${scope.accountId} project=${scope.projectSlug} environment=${scope.environmentSlug}`,
  );
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("start", String(start));
  url.searchParams.set("end", String(end));

  const response = await fetch(url.toString(), {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok)
    throw new Error(`Tempo search failed with HTTP ${response.status}`);

  const body = (await response.json()) as {
    traces?: Array<{
      traceID: string;
      rootSpanName?: string;
      rootTraceName?: string;
      startTimeUnixNano?: string;
      durationMs?: number;
    }>;
  };
  const rows = await mapWithConcurrency(
    body?.traces ?? [],
    TEMPO_DETAIL_CONCURRENCY,
    async (traceSummary) => {
      const detailResponse = await fetch(
        `${tempoUrl}/api/traces/${encodeURIComponent(traceSummary.traceID)}`,
        {
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!detailResponse.ok)
        throw new Error(
          `Tempo trace query failed with HTTP ${detailResponse.status}`,
        );

      return tempoTraceRowsFromResponse(
        await detailResponse.json(),
        traceSummary.traceID,
      );
    },
  );

  return rows
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .sort((a, b) => b.startTimeMs - a.startTimeMs);
}

async function startLiveSubscription(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
  scope: ObservabilityScope,
  stream: "logs" | "traces",
  state: ObservabilitySocketState,
  liveOnly: boolean,
  getNatsConnection: () => Promise<NatsConnection>,
): Promise<boolean> {
  try {
    const connection = await getNatsConnection();
    const messages = await readObservabilityStream({
      connection,
      stream,
      accountId: scope.accountId,
      project: scope.projectSlug,
      env: scope.environmentSlug,
      startTime: new Date(
        liveOnly ? Date.now() : Date.now() - OBS_REPLAY_WINDOW_MS,
      ).toISOString(),
    });
    const natsSub: NatsSubscription = { unsubscribe: () => messages.stop() };

    if (stream === "logs") {
      state.logsSub = natsSub;
    } else {
      state.tracesSub = natsSub;
    }

    void relayNatsMessages(socket, messages, stream, state);
    return true;
  } catch {
    return false;
  }
}

function cleanupObservabilityStream(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
  stream: "logs" | "traces",
): void {
  const state = obsState.get(socket);
  if (!state) return;

  if (stream === "logs" && state.logsSub) {
    state.logsSub.unsubscribe();
    state.logsSub = null;
  } else if (stream === "traces" && state.tracesSub) {
    state.tracesSub.unsubscribe();
    state.tracesSub = null;
  }
}

function sendObs(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
  payload: ObservabilityServerMessage,
): void {
  if (socket.readyState !== WebSocket.OPEN) return;

  try {
    socket.send(JSON.stringify(payload));
  } catch {
    return;
  }
}

function optionalString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function stringValue(...values: unknown[]): string {
  return optionalString(...values) ?? "";
}

function otelValue(value: OtelValue | undefined): unknown {
  if (!value) return undefined;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(otelValue);
  return undefined;
}

function otelAttributes(
  attributes: OtelAttribute[] | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const attribute of attributes ?? []) {
    if (attribute.key) result[attribute.key] = otelValue(attribute.value);
  }

  return result;
}

function spanKind(name: string): ObservabilitySpanRow["kind"] {
  if (name === "model.step") return "model.step";
  if (name === "tool.call") return "tool.call";
  if (name.startsWith("phase.")) return "phase";
  if (name === "agent.subtask") return "subtask";
  return "task";
}
