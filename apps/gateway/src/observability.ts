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
import {
  decoder,
  errorMessage,
  mapWithConcurrency,
  parseJson,
} from "./utils.ts";

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
type LokiRow = { entry: ObservabilityLogEntry; ns: bigint };
type ObservabilityStream = "logs" | "traces";
type ObservabilitySocketState = {
  scope: ObservabilityScope;
  // One live consumer per stream, and a generation bumped whenever that stream
  // is torn down: a consumer still opening or a backfill still running for the
  // old subscription sees the bump and stops instead of relaying into the new
  // one's.
  subs: Record<ObservabilityStream, LiveSubscription | null>;
  runs: Record<ObservabilityStream, number>;
  logsMinLevel: LogLevel;
  // The sandbox a logs subscription tails, so a repeat of the same subscribe
  // does not fire another Loki backfill scan.
  logsSandboxId: string | null;
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
// A search over the whole window walks every block in it; a single trace by
// id is an index hit. Both used to share 5 s, which the search blew through on
// a busy stage and left the Tracing tab "waiting" with no history at all.
const TEMPO_SEARCH_TIMEOUT_MS = 15_000;
const TEMPO_TRACE_TIMEOUT_MS = 5_000;
// Sandbox lines reach Loki via the CloudWatch bridge, never NATS, so a sandbox tail
// polls Loki (its tail endpoint caps at 10 concurrent requests cluster-wide). Guest
// timestamps trail arrival, by minutes when CloudWatch retries a failed delivery,
// so each poll re-reads a lookback window newest-first and dedupes.
const SANDBOX_LOG_POLL_MS = 2_000;
const SANDBOX_LOG_POLL_LIMIT = 1_000;
const SANDBOX_LOG_POLL_LOOKBACK_NS = 180n * 1_000_000_000n;
// The forwarder's service.name. Guest output is untrusted text, so it never
// joins the deployment stream, where a JSON line would read as a core record.
const SANDBOX_SERVICE_NAME = "broods-sandbox";
// The sandbox_id filter is structured metadata and scans every chunk in the window;
// one day covers any VM's lifetime and stays under the 5 s query timeout (30 days: 8 s).
const SANDBOX_LOG_BACKFILL_WINDOW_NS = 24n * 60n * 60n * 1_000_000_000n;
const NS_PER_MS = 1_000_000n;
const OBS_REPLAY_WINDOW_MS = 30 * 60 * 1000;
// Tempo mostly serialises trace-by-id lookups; 6 in flight buys about 20%
// over 1, more buys nothing.
const TEMPO_DETAIL_CONCURRENCY = 6;
// The backfill goes out newest first in chunks, so the Tracing tab paints
// after one chunk instead of after the whole batch. A single TraceQL search
// cannot replace the lookups: on Tempo 2.7 `select()` has no attribute
// wildcard and rejects `span:parentID`, both of which the rows need.
const TEMPO_BACKFILL_CHUNK = 12;
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
  if (msg.type === "fetchTrace") {
    await sendTrace(socket, socket.data.scope, msg.traceId);

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
    subs: { logs: null, traces: null },
    runs: { logs: 0, traces: 0 },
    logsMinLevel: "INFO",
    logsSandboxId: null,
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
 * the UUID shape by the wire contract, so it is safe to interpolate. The
 * deployment stream excludes the bridge's service, matching the live NATS relay.
 */
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

  // The same sandbox tail again is a no-op: the poll is already running, and a
  // fresh backfill would only rescan a day of Loki for lines the client has.
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
  // The bump above is this subscribe's claim on the stream. Opening the NATS
  // consumer yields, so a second subscribe can land meanwhile and bump again;
  // the generation is read here, not after, so only the newest one wins.
  const run = state.runs[stream];
  if (stream === "logs") {
    state.logsMinLevel = minLevel;
    state.logsSandboxId = sandboxId ?? null;
  }

  // A sandbox tail owns its backfill too: history and the first poll window
  // overlap, and one seen set across both is what keeps a line from going twice.
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
    // Superseded while the consumer opened: the newer subscribe owns the
    // stream, so neither this consumer nor its failure may reach it.
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
    void sendBackfill(socket, scope, stream, backfill, minLevel, run);
}

// Backfill honours the same minLevel as the live relay, so a client asking for
// errors never has to re-filter a screenful of Loki history. The client always
// gets a closing backfill message (one without `more`), failure included: a
// swallowed error used to leave the Tracing tab "waiting for traces" for good.
// `run` is the subscription this backfill serves; once the stream's generation
// moves past it, nothing more goes out, not even the failure closer.
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
      const rows = await fetchLokiLogs(
        lokiUrl,
        scope,
        lokiBackfillQuery(scope, minLevel),
        {
          startNs: nowNs() - BigInt(LOKI_BACKFILL_WINDOW_MS) * NS_PER_MS,
          limit: limit,
          direction: "backward",
        },
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
        // A re-subscribe or unsubscribe landed while this chunk was in
        // flight: a newer backfill owns the stream now.
        if (state.runs.traces !== run) return;
        failures += chunk.failures;
        const sent = sendObs(socket, {
          type: "backfill",
          stream: "traces",
          entries: chunk.rows,
          more: true,
        });
        // The socket is gone: stop paying Tempo for a tab nobody is watching.
        if (!sent) return;
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
    // A superseded run's failure would sit as `error` on the stream a newer
    // subscription owns, and a later good closer does not clear it.
    if (state.runs[stream] !== run) return;
    sendObs(socket, {
      type: "backfill",
      stream: stream,
      entries: [],
      error: errorMessage(error),
    });
  }
}

// One trace by id, for a log line's "View trace" when the trace is older than
// the backfill window covers. Tempo's id lookup is not tenant-scoped, so the
// spans are checked against the socket's scope before anything leaves.
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
    if (rows.length === 0) throw new Error("Trace not found in this stage");
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

/**
 * One Loki query_range call in Loki's own order (`backward` = newest first).
 * Each entry keeps its nanosecond timestamp so the sandbox poll can dedupe
 * across overlapping windows. A sandbox tail's lines are guest text: they are
 * relayed verbatim, never parsed as a core record.
 */
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

/**
 * The traces backfill: one tag-scoped Tempo search, then each trace's spans by
 * id, newest trace first, yielded a chunk at a time with the count of lookups
 * that failed in it. The caller turns a non-zero total into the closing
 * message's `error` so a half- or fully-failed history reads as a failure, not
 * an empty stage.
 */
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
  // Tempo's search result is not ordered; sort here so the first chunk is the
  // newest traces, the ones the Tracing tab shows at the top. The client
  // orders the rows inside a chunk itself.
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

async function fetchTempoTrace(
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

// Opens the NATS consumer for `run`, the stream generation the subscribe holds.
// Null when the transport is unavailable, or when a newer subscribe took the
// stream while the consumer opened: then it is stopped before it relays a line.
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

// A sandbox tail: Loki backfill first, then a poll every SANDBOX_LOG_POLL_MS
// over a lookback window, relaying only what this socket has not had yet. The
// seen set is pruned to the window, so it stays as small as the sandbox is
// chatty. The poll is armed only after the backfill settles, so the two never
// race on that set.
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

  // Marks every row as sent and keeps the ones that are new and pass the level.
  // Rows arrive newest first; the caller wants them in time order.
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
        },
        true,
      );
      // Unsubscribed while Loki answered: the rows belong to nobody now.
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

// True when the payload went out; false for a closed socket, a shed live
// entry, or a send that threw.
function sendObs(
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>,
  payload: ObservabilityServerMessage,
): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
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

function nowNs(): bigint {
  return BigInt(Date.now()) * NS_PER_MS;
}

/** Whether an entry is at or above the subscription's minimum level. */
// Tempo's search is scoped by tag, but a matched trace's detail can carry spans
// from other scopes, so every row is checked against the socket's scope before
// it leaves. Both the backfill and the single-trace fetch go through here.
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
