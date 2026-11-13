// The gateway, CLI and dashboard all import this: keep it free of runtime dependencies.

export const MAX_OBSERVABILITY_BACKFILL = 500;
const SANDBOX_LOG_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// W3C trace id; all zeros is the "no span" sentinel.
const TRACE_ID_PATTERN = /^(?!0{32}$)[0-9a-f]{32}$/;
// 16 bytes as base64url: the gateway seals the stream sequence so it shows no gaps.
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const MAX_AGENT_ID_LENGTH = 256;

// DEBUG never rides the live NATS relay: a client sees it only through Loki backfill.
export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export type ObservabilityLogEntry = {
  /** Core's id for the line: its live copy and its Loki replay share it. */
  logId?: string;
  ts: number;
  level: LogLevel;
  eventType: string;
  message: string;
  traceId?: string;
  accountId?: string;
  endpointId?: string;
  service?: string;
  agentId?: string;
  conversationKey?: string;
  data?: unknown;
};

// A subtask root owns its traceId and links its parent via parent.trace_id/parent.task_id.
// A root that ends with work open closes "needs_input" or "waiting"; `task.waiting_on` says why.
// Every run of one request carries its event id as `task.id`, or `task.root_id` if its own differs.
export type ObservabilitySpanRow = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: "task" | "cron" | "subtask" | "model.step" | "tool.call" | "phase";
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  status: "running" | "waiting" | "needs_input" | "ok" | "error";
  endpointId?: string;
  agentId?: string;
  conversationKey?: string;
  attributes?: Record<string, unknown>;
  error?: string;
};

export type TaskWaitingOn = "question" | "approval" | "subagent" | "tool";

export type ObservabilityHistoryRange = {
  from: number;
  to: number;
};

export type ObservabilitySubscribeMessage = {
  type: "subscribe";
  stream: "logs" | "traces";
  backfill?: number;
  liveOnly?: boolean;
  minLevel?: LogLevel;
  // Only the backfill: no live consumer, so a read of history needs no live transport.
  historyOnly?: boolean;
  range?: ObservabilityHistoryRange;
  // "logs" only: the UUID ending the instance's `logStream`; these lines never reach NATS.
  sandboxId?: string;
  // "traces" only: the backfill searches Tempo for this agent's traces alone.
  agentId?: string;
  // A reconnect's cursor, the last `seq` it saw: the live stream starts after it, not at the
  // replay window. Sent without `backfill` by a client that kept its entries.
  afterSeq?: string;
};

export type ObservabilityUnsubscribeMessage = {
  type: "unsubscribe";
  stream: "logs" | "traces";
};

// Answered by one "backfill" message: the trace's spans, or `error` when Tempo has none.
export type ObservabilityFetchTraceMessage = {
  type: "fetchTrace";
  traceId: string;
};

export type ObservabilityClientMessage =
  | ObservabilitySubscribeMessage
  | ObservabilityUnsubscribeMessage
  | ObservabilityFetchTraceMessage;

// Sent once the live subscription is up; any requested backfill follows it. `agentId` echoes
// the subscribe's filter, which a gateway that predates it ignores and never echoes. `seq` is
// the opaque cursor the live stream starts after; each live entry then carries its own.
export type ObservabilityReadyMessage = {
  type: "ready";
  agentId?: string;
  seq?: string;
};

// Always sent for a requested backfill, failure included. A traces backfill comes in pieces:
// all but the last carry `more`; the last carries `error` when a query failed.
export type ObservabilityBackfillMessage = {
  type: "backfill";
  stream: "logs" | "traces";
  entries: ObservabilityLogEntry[] | ObservabilitySpanRow[];
  more?: boolean;
  range?: ObservabilityHistoryRange;
  nextTo?: number;
  error?: string;
};

export type ObservabilityLogMessage = {
  type: "log";
  entry: ObservabilityLogEntry;
  seq?: string;
};

export type ObservabilitySpanMessage = {
  type: "span";
  entry: ObservabilitySpanRow;
  seq?: string;
};

export type ObservabilityErrorMessage = {
  type: "error";
  error: string;
};

export type ObservabilityServerMessage =
  | ObservabilityReadyMessage
  | ObservabilityBackfillMessage
  | ObservabilityLogMessage
  | ObservabilitySpanMessage
  | ObservabilityErrorMessage;

export function isLogLevel(value: unknown): value is LogLevel {
  return (
    value === "DEBUG" ||
    value === "INFO" ||
    value === "WARN" ||
    value === "ERROR"
  );
}

export function isObservabilityClientMessage(
  v: unknown,
): v is ObservabilityClientMessage {
  if (typeof v !== "object" || v === null) return false;
  const msg = v as Record<string, unknown>;
  if (msg["type"] === "subscribe") return isSubscribeMessage(msg);
  if (msg["type"] === "unsubscribe") return isStreamName(msg["stream"]);
  if (msg["type"] === "fetchTrace") return isTraceId(msg["traceId"]);

  return false;
}

export function isRootSpanKind(kind: ObservabilitySpanRow["kind"]): boolean {
  return kind === "task" || kind === "cron" || kind === "subtask";
}

/** Strict on purpose: the gateway interpolates it into LogQL. */
export function isSandboxLogId(value: unknown): value is string {
  return typeof value === "string" && SANDBOX_LOG_ID_PATTERN.test(value);
}

export function isTraceId(value: unknown): value is string {
  return typeof value === "string" && TRACE_ID_PATTERN.test(value);
}

function isStreamName(value: unknown): value is "logs" | "traces" {
  return value === "logs" || value === "traces";
}

function isSubscribeMessage(msg: Record<string, unknown>): boolean {
  const stream = msg["stream"];
  if (!isStreamName(stream)) return false;
  const backfill = msg["backfill"];
  if (
    backfill !== undefined &&
    (typeof backfill !== "number" ||
      !Number.isSafeInteger(backfill) ||
      backfill < 0 ||
      backfill > MAX_OBSERVABILITY_BACKFILL)
  )
    return false;
  if (msg["liveOnly"] !== undefined && typeof msg["liveOnly"] !== "boolean")
    return false;
  if (
    msg["historyOnly"] !== undefined &&
    typeof msg["historyOnly"] !== "boolean"
  )
    return false;
  const range = msg["range"] as ObservabilityHistoryRange | undefined;
  if (
    range !== undefined &&
    (range === null ||
      typeof range !== "object" ||
      !Number.isSafeInteger(range.from) ||
      !Number.isSafeInteger(range.to) ||
      range.from < 0 ||
      range.to <= range.from ||
      range.to - range.from > 30 * 24 * 60 * 60 * 1000)
  )
    return false;
  const minLevel = msg["minLevel"];
  if (minLevel !== undefined && !isLogLevel(minLevel)) return false;
  const sandboxId = msg["sandboxId"];
  if (
    sandboxId !== undefined &&
    !(stream === "logs" && isSandboxLogId(sandboxId))
  )
    return false;
  const afterSeq = msg["afterSeq"];
  if (
    afterSeq !== undefined &&
    (typeof afterSeq !== "string" ||
      !CURSOR_PATTERN.test(afterSeq) ||
      sandboxId !== undefined)
  )
    return false;
  const agentId = msg["agentId"];

  return (
    agentId === undefined ||
    (stream === "traces" &&
      typeof agentId === "string" &&
      agentId.length > 0 &&
      agentId.length <= MAX_AGENT_ID_LENGTH)
  );
}
