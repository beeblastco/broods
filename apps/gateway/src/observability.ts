import {
  isLogLevel,
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
  stageSlug: string;
  endpointIds: string[];
};

export type ObservabilityGatewayData = {
  kind: "observability";
  project: string;
  stage: string;
  token: string;
  scope: ObservabilityScope;
};

// A NATS consumer for the deployment's own stream, or the Loki poll loop that
// serves a sandbox tail; the socket state only ever needs to stop it.
type LiveSubscription = { unsubscribe(): void };
type LokiRange = {
  startNs: bigint;
  limit: number;
  direction: "backward" | "forward";
};
type ObservabilitySocketState = {
  scope: ObservabilityScope;
  logsSub: LiveSubscription | null;
  tracesSub: LiveSubscription | null;
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
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};
// Loki caps query ranges at 30d1h and Tempo search at 168h (their defaults);
// a wider window is rejected with HTTP 400 and the backfill delivers nothing.
const LOKI_BACKFILL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const TEMPO_BACKFILL_WINDOW_S = 7 * 24 * 60 * 60;
// Sandbox lines reach Loki via the CloudWatch bridge, never NATS, so a sandbox tail
// polls Loki (its tail endpoint caps at 10 concurrent requests cluster-wide). Guest
// timestamps trail arrival, so each poll re-reads a lookback window and dedupes.
const SANDBOX_LOG_POLL_MS = 2_000;
const SANDBOX_LOG_POLL_LIMIT = 500;
const SANDBOX_LOG_POLL_LOOKBACK_NS = 15n * 1_000_000_000n;
// The sandbox_id filter is structured metadata and scans every chunk in the window;
// one day covers any VM's lifetime and stays under the 5 s query timeout (30 days: 8 s).
const SANDBOX_LOG_BACKFILL_WINDOW_NS = 24n * 60n * 60n * 1_000_000_000n;
const NS_PER_MS = 1_000_000n;
const OBS_REPLAY_WINDOW_MS = 30 * 60 * 1000;
const TEMPO_DETAIL_CONCURRENCY = 6;
export const OBS_SHED_BUFFERED_BYTES = 512 * 1024;
// Span relay backpressure: re-check cadence and cap before shedding.
const OBS_DRAIN_POLL_MS = 20;
const OBS_DRAIN_MAX_WAIT_MS = 5_000;
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
    msg.sandboxId,
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
          if (!meetsMinLevel(entry, state.logsMinLevel)) continue;
          sendObs(socket, { type: "log", entry: entry });
        } else {
          // Replay outruns the tab's drain rate; shedding would drop the newest
          // rows — the terminal spans that mark recent tasks finished. Logs skip
          // the wait: they are small and Loki backfill restores a shed line.
          await waitForObsDrain(socket);
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

/**
 * LogQL for a durable backfill. Levels below `minLevel` are dropped by Loki
 * itself, so an errors-only tail reaches past a long quiet run of DEBUG instead
 * of returning whatever happens to sit in the newest page. Core stamps `level`
 * on every record it emits; a line that somehow arrives without one survives
 * the filter and is judged by meetsMinLevel. A sandbox tail narrows further on
 * the `sandbox_id` metadata the log bridge stamps; the id was validated against
 * the UUID shape by the wire contract, so it is safe to interpolate.
 */
export function lokiBackfillQuery(
  scope: ObservabilityScope,
  minLevel: LogLevel,
  sandboxId?: string,
): string {
  const selector = `{account_id=${quoteLabel(scope.accountId)},project=${quoteLabel(scope.projectSlug)},stage=${quoteLabel(scope.stageSlug)}}`;
  const filters = sandboxId ? [`sandbox_id=${quoteLabel(sandboxId)}`] : [];
  const below = Object.entries(LOG_LEVEL_ORDER)
    .filter(([, order]) => order < LOG_LEVEL_ORDER[minLevel])
    .map(([level]) => level);
  if (below.length > 0) filters.push(`level!~"(?i)(${below.join("|")})"`);

  return [selector, ...filters].join(" | ");
}

/**
 * Quote a scope value for a LogQL label matcher or a Tempo logfmt tag. Stage
 * slugs are tenant-named, so a quote or backslash in one must stay inside
 * the string instead of ending the matcher.
 */
export function quoteLabel(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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
  // Loki labels are lowercase (`detected_level=debug`) while core's own JSON
  // line is uppercase, so normalize before matching or every debug line from
  // the label path reads as INFO.
  const rawLevel =
    record.level ??
    metadata.level ??
    metadata.severity_text ??
    metadata.detected_level;
  const normalizedLevel =
    typeof rawLevel === "string" ? rawLevel.toUpperCase() : undefined;
  const level = isLogLevel(normalizedLevel) ? normalizedLevel : "INFO";
  const parsedTime =
    typeof record.ts === "number"
      ? record.ts
      : typeof record.time === "string"
        ? Date.parse(record.time)
        : Number.NaN;

  return {
    ts: Number.isFinite(parsedTime) ? parsedTime : fallbackTs,
    level: level,
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
          | { code?: unknown; message?: unknown }
          | undefined;
        const isError =
          status?.code === 2 || status?.code === "STATUS_CODE_ERROR";

        rows.push({
          traceId: traceId,
          spanId: spanId,
          ...(parentSpanId ? { parentSpanId: parentSpanId } : {}),
          name: name,
          kind: spanKind(name),
          startTimeMs: startTimeMs,
          endTimeMs: endTimeMs,
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
          attributes: attributes,
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
  sandboxId?: string,
): Promise<void> {
  const state = obsState.get(socket);
  if (!state) return;

  cleanupObservabilityStream(socket, stream);
  if (stream === "logs") state.logsMinLevel = minLevel;

  // A sandbox tail owns its backfill too: history and the first poll window
  // overlap, and one seen set across both is what keeps a line from going twice.
  const live = sandboxId
    ? startSandboxLogPoll(
        socket,
        scope,
        state,
        sandboxId,
        minLevel,
        backfill ?? 0,
      )
    : await startLiveSubscription(
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
  if (!sandboxId && typeof backfill === "number" && backfill > 0)
    void sendBackfill(socket, scope, stream, backfill, minLevel);
}

// Backfill honours the same minLevel as the live relay, so a client asking for
// errors never has to re-filter a screenful of Loki history.
async function sendBackfill(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
  scope: ObservabilityScope,
  stream: "logs" | "traces",
  limit: number,
  minLevel: LogLevel,
): Promise<boolean> {
  try {
    if (stream === "logs") {
      const lokiUrl = process.env.LOKI_URL?.trim();
      if (!lokiUrl) return false;
      const { entries } = await fetchLokiLogs(
        lokiUrl,
        scope,
        lokiBackfillQuery(scope, minLevel),
        {
          startNs: nowNs() - BigInt(LOKI_BACKFILL_WINDOW_MS) * NS_PER_MS,
          limit: limit,
          direction: "backward",
        },
      );
      sendObs(socket, {
        type: "backfill",
        stream: "logs",
        entries: entries
          .reverse()
          .filter((entry) => meetsMinLevel(entry, minLevel)),
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
  } catch (error) {
    // Surface the failure instead of letting it look like empty history.
    console.error(`observability ${stream} backfill failed:`, error);

    return false;
  }
}

/**
 * One Loki query_range call in Loki's own order (`backward` = newest first).
 * Each entry keeps its nanosecond timestamp so the sandbox poll can dedupe
 * across overlapping windows.
 */
async function fetchLokiLogs(
  lokiUrl: string,
  scope: ObservabilityScope,
  query: string,
  range: LokiRange,
): Promise<{ entries: ObservabilityLogEntry[]; timestamps: bigint[] }> {
  const url = new URL(`${lokiUrl}/loki/api/v1/query_range`);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(range.limit));
  url.searchParams.set("direction", range.direction);
  url.searchParams.set("start", String(range.startNs));
  url.searchParams.set("end", String(nowNs()));

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
  const timestamps: bigint[] = [];

  for (const stream of body?.data?.result ?? []) {
    for (const [nsStr, line] of stream.values) {
      const ns = BigInt(nsStr);
      timestamps.push(ns);
      entries.push(
        lokiLogEntry(
          stream.stream,
          line,
          Number(ns / NS_PER_MS),
          scope.accountId,
        ),
      );
    }
  }

  return { entries: entries, timestamps: timestamps };
}

async function fetchTempoBackfill(
  tempoUrl: string,
  scope: ObservabilityScope,
  limit: number,
): Promise<ObservabilitySpanRow[]> {
  const url = new URL(`${tempoUrl}/api/search`);
  const end = Math.floor(Date.now() / 1_000);
  const start = end - TEMPO_BACKFILL_WINDOW_S;
  url.searchParams.set(
    "tags",
    `account_id=${quoteLabel(scope.accountId)} project=${quoteLabel(scope.projectSlug)} stage=${quoteLabel(scope.stageSlug)}`,
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
      connection: connection,
      stream: stream,
      accountId: scope.accountId,
      project: scope.projectSlug,
      stage: scope.stageSlug,
      startTime: new Date(
        liveOnly ? Date.now() : Date.now() - OBS_REPLAY_WINDOW_MS,
      ).toISOString(),
    });
    const natsSub: LiveSubscription = { unsubscribe: () => messages.stop() };

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

// A sandbox tail: Loki backfill first, then a poll every SANDBOX_LOG_POLL_MS
// over a lookback window, relaying only what this socket has not had yet. The
// seen set is pruned to the window, so it stays as small as the sandbox is
// chatty. The poll is armed only after the backfill settles, so the two never
// race on that set.
function startSandboxLogPoll(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
  scope: ObservabilityScope,
  state: ObservabilitySocketState,
  sandboxId: string,
  minLevel: LogLevel,
  backfill: number,
): boolean {
  const lokiUrl = process.env.LOKI_URL?.trim();
  if (!lokiUrl) return false;

  const query = lokiBackfillQuery(scope, minLevel, sandboxId);
  const seen = new Map<string, bigint>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let inFlight = false;

  // Marks every entry as sent and keeps the ones that are new and pass the level.
  const unseen = (
    entries: ObservabilityLogEntry[],
    timestamps: bigint[],
  ): ObservabilityLogEntry[] =>
    entries.filter((entry, index) => {
      const ns = timestamps[index]!;
      const key = `${ns}:${entry.message}`;
      if (seen.has(key)) return false;
      seen.set(key, ns);

      return meetsMinLevel(entry, minLevel);
    });

  const poll = async (): Promise<void> => {
    if (inFlight || socket.readyState !== WebSocket.OPEN) return;
    inFlight = true;
    try {
      const floorNs = nowNs() - SANDBOX_LOG_POLL_LOOKBACK_NS;
      const { entries, timestamps } = await fetchLokiLogs(
        lokiUrl,
        scope,
        query,
        {
          startNs: floorNs,
          limit: SANDBOX_LOG_POLL_LIMIT,
          direction: "forward",
        },
      );
      for (const [key, ns] of seen) if (ns < floorNs) seen.delete(key);
      for (const entry of unseen(entries, timestamps))
        sendObs(socket, { type: "log", entry: entry });
    } catch (error) {
      console.error("observability sandbox log poll failed:", error);
    } finally {
      inFlight = false;
    }
  };

  const start = async (): Promise<void> => {
    if (backfill > 0) {
      try {
        const { entries, timestamps } = await fetchLokiLogs(
          lokiUrl,
          scope,
          query,
          {
            startNs: nowNs() - SANDBOX_LOG_BACKFILL_WINDOW_NS,
            limit: backfill,
            direction: "backward",
          },
        );
        sendObs(socket, {
          type: "backfill",
          stream: "logs",
          entries: unseen(entries.reverse(), timestamps.reverse()),
        });
      } catch (error) {
        console.error("observability sandbox backfill failed:", error);
      }
    }
    if (!stopped) timer = setInterval(() => void poll(), SANDBOX_LOG_POLL_MS);
  };

  state.logsSub = {
    unsubscribe: (): void => {
      stopped = true;
      clearInterval(timer);
    },
  };
  void start();

  return true;
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

// Wait for a backed-up socket to drain below the shed threshold. Bounded so a
// dead tab cannot pin the relay loop; on timeout the send falls through to
// sendObs shedding.
async function waitForObsDrain(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
): Promise<void> {
  const deadline = Date.now() + OBS_DRAIN_MAX_WAIT_MS;
  while (
    socket.readyState === WebSocket.OPEN &&
    socket.getBufferedAmount() > OBS_SHED_BUFFERED_BYTES &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, OBS_DRAIN_POLL_MS));
  }
}

function sendObs(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
  payload: ObservabilityServerMessage,
): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (
    (payload.type === "log" || payload.type === "span") &&
    socket.getBufferedAmount() > OBS_SHED_BUFFERED_BYTES
  ) {
    return;
  }

  try {
    socket.send(JSON.stringify(payload));
  } catch {
    return;
  }
}

function nowNs(): bigint {
  return BigInt(Date.now()) * NS_PER_MS;
}

/** Whether an entry is at or above the subscription's minimum level. */
function meetsMinLevel(
  entry: ObservabilityLogEntry,
  minLevel: LogLevel,
): boolean {
  if (!isLogLevel(entry.level)) return false;

  return LOG_LEVEL_ORDER[entry.level] >= LOG_LEVEL_ORDER[minLevel];
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
  if (name === "agent.cron") return "cron";

  return "task";
}
