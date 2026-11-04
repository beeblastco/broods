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
import { resolveSocketScope, type CredentialScope } from "./upstream.ts";
import {
  decoder,
  errorMessage,
  mapWithConcurrency,
  parseJson,
} from "./utils.ts";

export type ObservabilityScope = CredentialScope & { expiresAt: number };

export type ObservabilityGatewayData = {
  kind: "observability";
  scope: ObservabilityScope;
  token: string;
};

type LiveSubscription = { unsubscribe(): void };
type LokiRange = {
  startNs: bigint;
  limit: number;
  direction: "backward" | "forward";
  timeoutMs: number;
};
type LokiRow = { entry: ObservabilityLogEntry; ns: bigint };
type ObservabilityStream = "logs" | "traces";
type ObservabilitySocketState = {
  subs: Record<ObservabilityStream, LiveSubscription | null>;
  // Bumped on each teardown: a consumer still opening or a backfill still running for the old
  // subscription sees it and stops instead of relaying into the new one.
  runs: Record<ObservabilityStream, number>;
  logsMinLevel: LogLevel;
  logsSandboxId: string | null;
  // Chained, so a socket never runs two Loki or Tempo backfills for one stream.
  backfills: Record<ObservabilityStream, Promise<void>>;
  fetchingTrace: boolean;
  lifetime?: ReturnType<typeof setTimeout>;
};
type OtelValue = {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: OtelValue[] };
};
type OtelAttribute = { key?: string; value?: OtelValue };
type TempoTraceEntry = {
  rows: Promise<ObservabilitySpanRow[]>;
  expiresAtMs: number;
};

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};
// Loki caps query ranges at 30d1h and Tempo search at 168h; wider is an HTTP 400.
const LOKI_BACKFILL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
// Loki scans the whole range whatever the row limit (one CPU, no results cache), so start cheap
// and widen only on a short page. A timed-out step ends it: wider is never cheaper.
const LOKI_BACKFILL_STEPS: ReadonlyArray<{
  windowMs: number;
  timeoutMs: number;
}> = [
  { windowMs: 60 * 60 * 1000, timeoutMs: 5_000 },
  { windowMs: 24 * 60 * 60 * 1000, timeoutMs: 10_000 },
  { windowMs: LOKI_BACKFILL_WINDOW_MS, timeoutMs: 15_000 },
];
const LOKI_SANDBOX_BACKFILL_TIMEOUT_MS = 15_000;
const LOKI_POLL_TIMEOUT_MS = 5_000;
const TEMPO_BACKFILL_WINDOW_S = 7 * 24 * 60 * 60;
// `tempo.retention` in the infra repo's kubernetes/charts/releases/tempo.yaml.
const TEMPO_RETENTION_DAYS = 30;
// A search walks every block in the window; a trace by id is an index hit.
const TEMPO_SEARCH_TIMEOUT_MS = 15_000;
const TEMPO_TRACE_TIMEOUT_MS = 5_000;
// A still-growing trace is inside the NATS replay window, so a stale shared answer never shows.
const TEMPO_TRACE_SHARE_MS = 5 * 60 * 1000;
const TEMPO_TRACE_CACHE_MAX = 5_000;
// Sandbox lines reach Loki via CloudWatch, never NATS, and Loki's tail API caps at 10 clients,
// so poll. Guest timestamps trail arrival by minutes on a retry: re-read a lookback and dedupe.
const SANDBOX_LOG_POLL_MS = 2_000;
const SANDBOX_LOG_POLL_LIMIT = 1_000;
const SANDBOX_LOG_POLL_LOOKBACK_NS = 180n * 1_000_000_000n;
// Guest output is untrusted: kept off the deployment stream, where JSON would read as core's.
const SANDBOX_SERVICE_NAME = "broods-sandbox";
// sandbox_id is structured metadata, so its filter scans every chunk; a day covers any VM.
const SANDBOX_LOG_BACKFILL_WINDOW_NS = 24n * 60n * 60n * 1_000_000_000n;
const NS_PER_MS = 1_000_000n;
const OBS_REPLAY_WINDOW_MS = 30 * 60 * 1000;
// Tempo mostly serialises trace-by-id lookups; past 6 in flight buys nothing.
const TEMPO_DETAIL_CONCURRENCY = 6;
// No single TraceQL search instead: Tempo 2.7 select() has no wildcard, rejects span:parentID.
const TEMPO_BACKFILL_CHUNK = 12;
const OBS_SHED_BUFFERED_BYTES = 512 * 1024;
const OBS_DRAIN_POLL_MS = 20;
const OBS_DRAIN_MAX_WAIT_MS = 5_000;
// Expiry is not fatal (the client reconnects with a fresh ticket); the CLI stops on 4401.
const OBS_EXPIRED_CLOSE = { code: 4419, reason: "Stage session expired" };
const OBS_REVOKED_CLOSE = {
  code: 4401,
  reason: "Unauthorized; the stage session was revoked",
};
const OBS_REVALIDATE_MS = 60_000;
const obsState = new WeakMap<
  Bun.ServerWebSocket<ObservabilityGatewayData>,
  ObservabilitySocketState
>();
const tempoTraces = new Map<string, TempoTraceEntry>();

export async function handleObservabilityMessage(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
  rawMessage: string | Buffer,
  getNatsConnection: () => Promise<NatsConnection>,
): Promise<void> {
  if (closeIfExpired(socket)) return;
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
  if (msg.type === "fetchTrace") {
    const state = obsState.get(socket);
    if (!state) return;
    if (state.fetchingTrace) {
      sendObs(socket, {
        type: "backfill",
        stream: "traces",
        entries: [],
        error: "A trace lookup is already running",
      });

      return;
    }
    state.fetchingTrace = true;
    try {
      await sendTrace(socket, socket.data.scope, msg.traceId);
    } finally {
      state.fetchingTrace = false;
    }

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
          // Shedding would drop the newest rows, the spans that finish tasks; Loki restores logs.
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
    subs: { logs: null, traces: null },
    runs: { logs: 0, traces: 0 },
    logsMinLevel: "INFO",
    logsSandboxId: null,
    backfills: { logs: Promise.resolve(), traces: Promise.resolve() },
    fetchingTrace: false,
  });
}

// Re-asks core every minute so a suspended account loses its tail before the ticket expires.
// An outage keeps the socket: only a refusal closes it.
export function watchObservabilityLifetime(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
  coreBaseUrl: string,
): void {
  const state = obsState.get(socket);
  if (!state) return;
  state.lifetime = setTimeout(
    async (): Promise<void> => {
      if (closeIfExpired(socket)) return;
      const resolved = await resolveSocketScope(
        "observability",
        socket.data.token,
        coreBaseUrl,
      );
      if (!obsState.has(socket) || closeIfExpired(socket)) return;
      if (resolved.kind === "invalid") {
        socket.close(OBS_REVOKED_CLOSE.code, OBS_REVOKED_CLOSE.reason);

        return;
      }
      watchObservabilityLifetime(socket, coreBaseUrl);
    },
    Math.min(socket.data.scope.expiresAt - Date.now(), OBS_REVALIDATE_MS),
  );
}

export function cleanupObservabilitySocket(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
): void {
  clearTimeout(obsState.get(socket)?.lifetime);
  cleanupObservabilityStream(socket, "logs");
  cleanupObservabilityStream(socket, "traces");
  obsState.delete(socket);
}

// Loki drops levels below minLevel, so an errors-only page reaches past a run of DEBUG.
// sandboxId is safe to interpolate: the wire contract checks its UUID shape.
export function lokiBackfillQuery(
  scope: ObservabilityScope,
  minLevel: LogLevel,
  sandboxId?: string,
): string {
  const tenant = `account_id=${quoteLabel(scope.accountId)},project=${quoteLabel(scope.projectSlug)},stage=${quoteLabel(scope.stageSlug)}`;
  const selector = sandboxId
    ? `{${tenant}}`
    : `{${tenant},service_name!=${quoteLabel(SANDBOX_SERVICE_NAME)}}`;
  const filters = sandboxId ? [`sandbox_id=${quoteLabel(sandboxId)}`] : [];
  const below = Object.entries(LOG_LEVEL_ORDER)
    .filter(([, order]) => order < LOG_LEVEL_ORDER[minLevel])
    .map(([level]) => level);
  if (below.length > 0) filters.push(`level!~"(?i)(${below.join("|")})"`);

  return [selector, ...filters].join(" | ");
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
  // Loki labels are lowercase (`detected_level=debug`); core's own JSON line is uppercase.
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
    // Matches core's live fallback, so a replayed row dedupes against its live copy.
    eventType: stringValue(
      record.eventType,
      metadata.eventType,
      level.toLowerCase(),
    ),
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

// Stage slugs are tenant-named: a quote or backslash must not end the LogQL or Tempo matcher.
export function quoteLabel(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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
        // OTel knows only ok and error; a root that closed waiting keeps that in task.state.
        const taskState = attributes["task.state"];
        const openState =
          taskState === "waiting" || taskState === "needs_input"
            ? taskState
            : undefined;

        rows.push({
          traceId: traceId,
          spanId: spanId,
          ...(parentSpanId ? { parentSpanId: parentSpanId } : {}),
          name: name,
          kind: spanKind(name),
          startTimeMs: startTimeMs,
          endTimeMs: endTimeMs,
          durationMs: Math.max(0, endTimeMs - startTimeMs),
          status: isError ? "error" : (openState ?? "ok"),
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

export function resetTempoTraceCacheForTests(): void {
  tempoTraces.clear();
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

  // The same sandbox tail again: its poll runs already, a backfill would rescan a day of Loki.
  if (
    sandboxId &&
    state.subs.logs &&
    state.logsSandboxId === sandboxId &&
    state.logsMinLevel === minLevel
  ) {
    sendObs(socket, { type: "ready" });

    return;
  }

  cleanupObservabilityStream(socket, stream);
  // Read before opening the consumer yields, so a subscribe landing meanwhile supersedes this.
  const run = state.runs[stream];
  if (stream === "logs") {
    state.logsMinLevel = minLevel;
    state.logsSandboxId = sandboxId ?? null;
  }

  // A sandbox tail owns its backfill: one seen set across history and polls dedupes overlap.
  const live = sandboxId
    ? startSandboxLogPoll(socket, scope, sandboxId, minLevel, backfill ?? 0)
    : await startLiveSubscription(
        socket,
        scope,
        stream,
        state,
        run,
        liveOnly,
        getNatsConnection,
      );
  if (state.runs[stream] !== run) {
    live?.unsubscribe();

    return;
  }
  if (!live) {
    sendObs(socket, {
      type: "error",
      error: "Live observability transport is unavailable.",
    });

    return;
  }
  state.subs[stream] = live;

  sendObs(socket, { type: "ready" });
  if (!sandboxId && typeof backfill === "number" && backfill > 0)
    state.backfills[stream] = state.backfills[stream].then(
      (): Promise<void> | undefined =>
        state.runs[stream] === run
          ? sendBackfill(socket, scope, stream, backfill, minLevel, run)
          : undefined,
    );
}

// Always ends with one closer (no `more`), failure included, or the tab waits forever; but once
// the stream's generation passes `run`, nothing goes out, not even the closer.
async function sendBackfill(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
  scope: ObservabilityScope,
  stream: ObservabilityStream,
  limit: number,
  minLevel: LogLevel,
  run: number,
): Promise<void> {
  const state = obsState.get(socket);
  if (!state) return;

  try {
    if (stream === "logs") {
      const lokiUrl = process.env.LOKI_URL?.trim();
      if (!lokiUrl) throw new Error("Log history is not configured (LOKI_URL)");
      const rows = await fetchLokiBackfill(
        lokiUrl,
        scope,
        lokiBackfillQuery(scope, minLevel),
        limit,
      );
      if (state.runs.logs !== run) return;
      sendObs(socket, {
        type: "backfill",
        stream: "logs",
        entries: rows
          .reverse()
          .map((row) => row.entry)
          .filter((entry) => meetsMinLevel(entry, minLevel)),
      });
    } else {
      const tempoUrl = process.env.TEMPO_URL?.trim();
      if (!tempoUrl)
        throw new Error("Trace history is not configured (TEMPO_URL)");
      let failures = 0;
      for await (const chunk of fetchTempoBackfill(tempoUrl, scope, limit)) {
        failures += chunk.failures;
        const traces = new Map<string, ObservabilitySpanRow[]>();
        for (const row of chunk.rows) {
          const rows = traces.get(row.traceId);
          if (rows) rows.push(row);
          else traces.set(row.traceId, [row]);
        }
        // One trace per message on an empty buffer: a chunk could pass backpressure and close it.
        for (const rows of traces.values()) {
          await waitForObsDrain(socket, 0);
          if (state.runs.traces !== run) return;
          const sent = sendObs(socket, {
            type: "backfill",
            stream: "traces",
            entries: rows,
            more: true,
          });
          if (!sent) return;
        }
      }
      if (state.runs.traces !== run) return;
      sendObs(socket, {
        type: "backfill",
        stream: "traces",
        entries: [],
        ...(failures > 0
          ? {
              error: `${failures} trace${failures === 1 ? "" : "s"} could not be loaded from Tempo`,
            }
          : {}),
      });
    }
  } catch (error) {
    console.error(`observability ${stream} backfill failed:`, error);
    // A later good closer does not clear an error, so a superseded run must not send one.
    if (state.runs[stream] !== run) return;
    sendObs(socket, {
      type: "backfill",
      stream: stream,
      entries: [],
      error: errorMessage(error),
    });
  }
}

async function sendTrace(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
  scope: ObservabilityScope,
  traceId: string,
): Promise<void> {
  try {
    const tempoUrl = process.env.TEMPO_URL?.trim();
    if (!tempoUrl)
      throw new Error("Trace history is not configured (TEMPO_URL)");
    const rows = (await fetchTempoTrace(tempoUrl, traceId)).filter((row) =>
      rowInScope(row, scope),
    );
    if (rows.length === 0) {
      throw new Error(
        `Trace not found in this stage. Traces are kept ${TEMPO_RETENTION_DAYS} days`,
      );
    }
    sendObs(socket, { type: "backfill", stream: "traces", entries: rows });
  } catch (error) {
    console.error("observability trace fetch failed:", error);
    sendObs(socket, {
      type: "backfill",
      stream: "traces",
      entries: [],
      error: errorMessage(error),
    });
  }
}

async function fetchLokiBackfill(
  lokiUrl: string,
  scope: ObservabilityScope,
  query: string,
  limit: number,
): Promise<LokiRow[]> {
  let rows: LokiRow[] = [];
  for (const step of LOKI_BACKFILL_STEPS) {
    rows = await fetchLokiLogs(lokiUrl, scope, query, {
      startNs: nowNs() - BigInt(step.windowMs) * NS_PER_MS,
      limit: limit,
      direction: "backward",
      timeoutMs: step.timeoutMs,
    });
    if (rows.length >= limit) break;
  }

  return rows;
}

async function fetchLokiLogs(
  lokiUrl: string,
  scope: ObservabilityScope,
  query: string,
  range: LokiRange,
  sandbox = false,
): Promise<LokiRow[]> {
  const url = new URL(`${lokiUrl}/loki/api/v1/query_range`);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(range.limit));
  url.searchParams.set("direction", range.direction);
  url.searchParams.set("start", String(range.startNs));
  url.searchParams.set("end", String(nowNs()));

  const response = await fetch(url.toString(), {
    signal: AbortSignal.timeout(range.timeoutMs),
  }).catch((error: unknown) => {
    if (error instanceof DOMException && error.name === "TimeoutError")
      throw new Error(`Loki query timed out after ${range.timeoutMs}ms`);

    throw error;
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
  const rows: LokiRow[] = [];

  for (const stream of body?.data?.result ?? []) {
    for (const [nsStr, line] of stream.values) {
      const ns = BigInt(nsStr);
      const ts = Number(ns / NS_PER_MS);
      rows.push({
        ns: ns,
        entry: sandbox
          ? {
              ts: ts,
              level: "INFO",
              eventType: "sandbox",
              message: line,
              accountId: scope.accountId,
            }
          : lokiLogEntry(stream.stream, line, ts, scope.accountId),
      });
    }
  }

  return rows;
}

// `failures` feeds the closer's error, so a failed history never reads as an empty stage.
export async function* fetchTempoBackfill(
  tempoUrl: string,
  scope: ObservabilityScope,
  limit: number,
): AsyncGenerator<{ rows: ObservabilitySpanRow[]; failures: number }> {
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
    signal: AbortSignal.timeout(TEMPO_SEARCH_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`Tempo search failed with HTTP ${response.status}`);

  const body = (await response.json()) as {
    traces?: Array<{ traceID: string; startTimeUnixNano?: string }>;
  };
  // Tempo's search result is unordered; newest first, so the first chunk tops the Tracing tab.
  const summaries = (body?.traces ?? []).sort((a, b) =>
    BigInt(b.startTimeUnixNano ?? "0") > BigInt(a.startTimeUnixNano ?? "0")
      ? 1
      : -1,
  );

  for (let at = 0; at < summaries.length; at += TEMPO_BACKFILL_CHUNK) {
    const results = await mapWithConcurrency(
      summaries.slice(at, at + TEMPO_BACKFILL_CHUNK),
      TEMPO_DETAIL_CONCURRENCY,
      (traceSummary) => fetchTempoTrace(tempoUrl, traceSummary.traceID),
    );
    yield {
      rows: results
        .flatMap((result) =>
          result.status === "fulfilled" ? result.value : [],
        )
        .filter((row) => rowInScope(row, scope)),
      failures: results.filter((result) => result.status === "rejected").length,
    };
  }
}

// Unscoped rows: every caller filters them with rowInScope.
function fetchTempoTrace(
  tempoUrl: string,
  traceId: string,
): Promise<ObservabilitySpanRow[]> {
  const nowMs = Date.now();
  // Entries are only appended and share one lifetime, so expired ones lead.
  for (const [cachedId, entry] of tempoTraces) {
    if (entry.expiresAtMs > nowMs) break;
    tempoTraces.delete(cachedId);
  }
  const cached = tempoTraces.get(traceId);
  if (cached) return cached.rows;

  const rows = requestTempoTrace(tempoUrl, traceId);
  tempoTraces.set(traceId, {
    rows: rows,
    expiresAtMs: nowMs + TEMPO_TRACE_SHARE_MS,
  });
  if (tempoTraces.size > TEMPO_TRACE_CACHE_MAX) {
    const oldest = tempoTraces.keys().next().value;
    if (oldest !== undefined) tempoTraces.delete(oldest);
  }
  rows.catch((): void => {
    if (tempoTraces.get(traceId)?.rows === rows) tempoTraces.delete(traceId);
  });

  return rows;
}

async function requestTempoTrace(
  tempoUrl: string,
  traceId: string,
): Promise<ObservabilitySpanRow[]> {
  const response = await fetch(
    `${tempoUrl}/api/traces/${encodeURIComponent(traceId)}`,
    { signal: AbortSignal.timeout(TEMPO_TRACE_TIMEOUT_MS) },
  );
  if (response.status === 404) return [];
  if (!response.ok)
    throw new Error(`Tempo trace query failed with HTTP ${response.status}`);

  return tempoTraceRowsFromResponse(await response.json(), traceId);
}

async function startLiveSubscription(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
  scope: ObservabilityScope,
  stream: ObservabilityStream,
  state: ObservabilitySocketState,
  run: number,
  liveOnly: boolean,
  getNatsConnection: () => Promise<NatsConnection>,
): Promise<LiveSubscription | null> {
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
    if (state.runs[stream] !== run) {
      messages.stop();

      return null;
    }
    void relayNatsMessages(socket, messages, stream, state);

    return { unsubscribe: (): void => messages.stop() };
  } catch {
    return null;
  }
}

// The poll arms only after the backfill settles, so the two never race on `seen`.
function startSandboxLogPoll(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
  scope: ObservabilityScope,
  sandboxId: string,
  minLevel: LogLevel,
  backfill: number,
): LiveSubscription | null {
  const lokiUrl = process.env.LOKI_URL?.trim();
  if (!lokiUrl) return null;

  const query = lokiBackfillQuery(scope, minLevel, sandboxId);
  const seen = new Map<string, bigint>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let inFlight = false;

  const unseen = (rows: LokiRow[]): ObservabilityLogEntry[] =>
    rows
      .reverse()
      .filter((row) => {
        const key = `${row.ns}:${row.entry.message}`;
        if (seen.has(key)) return false;
        seen.set(key, row.ns);

        return meetsMinLevel(row.entry, minLevel);
      })
      .map((row) => row.entry);

  const poll = async (): Promise<void> => {
    if (inFlight || socket.readyState !== WebSocket.OPEN) return;
    inFlight = true;
    try {
      const floorNs = nowNs() - SANDBOX_LOG_POLL_LOOKBACK_NS;
      const rows = await fetchLokiLogs(
        lokiUrl,
        scope,
        query,
        {
          startNs: floorNs,
          limit: SANDBOX_LOG_POLL_LIMIT,
          direction: "backward",
          timeoutMs: LOKI_POLL_TIMEOUT_MS,
        },
        true,
      );
      if (stopped) return;
      for (const [key, ns] of seen) if (ns < floorNs) seen.delete(key);
      for (const entry of unseen(rows))
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
        const rows = await fetchLokiLogs(
          lokiUrl,
          scope,
          query,
          {
            startNs: nowNs() - SANDBOX_LOG_BACKFILL_WINDOW_NS,
            limit: backfill,
            direction: "backward",
            timeoutMs: LOKI_SANDBOX_BACKFILL_TIMEOUT_MS,
          },
          true,
        );
        if (stopped) return;
        sendObs(socket, {
          type: "backfill",
          stream: "logs",
          entries: unseen(rows),
        });
      } catch (error) {
        console.error("observability sandbox backfill failed:", error);
        if (stopped) return;
        sendObs(socket, {
          type: "backfill",
          stream: "logs",
          entries: [],
          error: errorMessage(error),
        });
      }
    }
    if (!stopped) timer = setInterval(() => void poll(), SANDBOX_LOG_POLL_MS);
  };

  void start();

  return {
    unsubscribe: (): void => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function cleanupObservabilityStream(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
  stream: "logs" | "traces",
): void {
  const state = obsState.get(socket);
  if (!state) return;

  state.subs[stream]?.unsubscribe();
  state.subs[stream] = null;
  state.runs[stream] += 1;
  if (stream === "logs") state.logsSandboxId = null;
}

// Bounded so a dead tab cannot pin the relay loop; past the deadline sendObs sheds.
async function waitForObsDrain(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
  maxBufferedBytes = OBS_SHED_BUFFERED_BYTES,
): Promise<void> {
  const deadline = Date.now() + OBS_DRAIN_MAX_WAIT_MS;
  while (
    socket.readyState === WebSocket.OPEN &&
    socket.getBufferedAmount() > maxBufferedBytes &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, OBS_DRAIN_POLL_MS));
  }
}

function sendObs(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
  payload: ObservabilityServerMessage,
): boolean {
  if (socket.readyState !== WebSocket.OPEN || closeIfExpired(socket))
    return false;
  if (
    (payload.type === "log" || payload.type === "span") &&
    socket.getBufferedAmount() > OBS_SHED_BUFFERED_BYTES
  ) {
    return false;
  }

  try {
    socket.send(JSON.stringify(payload));
  } catch {
    return false;
  }

  return true;
}

// Timers run late under load, so every send checks the deadline itself.
function closeIfExpired(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
): boolean {
  if (Date.now() < socket.data.scope.expiresAt) return false;
  socket.close(OBS_EXPIRED_CLOSE.code, OBS_EXPIRED_CLOSE.reason);

  return true;
}

function nowNs(): bigint {
  return BigInt(Date.now()) * NS_PER_MS;
}

function meetsMinLevel(
  entry: ObservabilityLogEntry,
  minLevel: LogLevel,
): boolean {
  if (!isLogLevel(entry.level)) return false;

  return LOG_LEVEL_ORDER[entry.level] >= LOG_LEVEL_ORDER[minLevel];
}

// Tempo's trace detail is not tenant-scoped: a matched trace can carry other scopes' spans.
function rowInScope(
  row: ObservabilitySpanRow,
  scope: ObservabilityScope,
): boolean {
  return (
    row.attributes?.account_id === scope.accountId &&
    row.attributes?.project === scope.projectSlug &&
    row.attributes?.stage === scope.stageSlug
  );
}

function optionalString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function stringValue(...values: unknown[]): string {
  return optionalString(...values) ?? "";
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

function otelValue(value: OtelValue | undefined): unknown {
  if (!value) return undefined;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(otelValue);

  return undefined;
}

function spanKind(name: string): ObservabilitySpanRow["kind"] {
  if (name === "model.step") return "model.step";
  if (name === "tool.call") return "tool.call";
  if (name.startsWith("phase.")) return "phase";
  if (name === "agent.subtask") return "subtask";
  if (name === "agent.cron") return "cron";

  return "task";
}
