// The gateway, CLI and dashboard all import this: keep it free of runtime dependencies.

export const MAX_OBSERVABILITY_BACKFILL = 500;
const SANDBOX_LOG_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// W3C trace id; all zeros is the "no span" sentinel.
const TRACE_ID_PATTERN = /^(?!0{32}$)[0-9a-f]{32}$/;

// DEBUG never rides the live NATS relay: a client sees it only through Loki backfill.
export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export type ObservabilityLogEntry = {
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

export type ObservabilitySubscribeMessage = {
  type: "subscribe";
  stream: "logs" | "traces";
  backfill?: number;
  liveOnly?: boolean;
  minLevel?: LogLevel;
  // "logs" only: the UUID ending the instance's `logStream`; these lines never reach NATS.
  sandboxId?: string;
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

// Sent once the live subscription is up; any requested backfill follows it.
export type ObservabilityReadyMessage = { type: "ready" };

// Always sent for a requested backfill, failure included. A traces backfill comes in pieces:
// all but the last carry `more`; the last carries `error` when a query failed.
export type ObservabilityBackfillMessage = {
  type: "backfill";
  stream: "logs" | "traces";
  entries: ObservabilityLogEntry[] | ObservabilitySpanRow[];
  more?: boolean;
  error?: string;
};

export type ObservabilityLogMessage = {
  type: "log";
  entry: ObservabilityLogEntry;
};

export type ObservabilitySpanMessage = {
  type: "span";
  entry: ObservabilitySpanRow;
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
  const minLevel = msg["minLevel"];
  if (minLevel !== undefined && !isLogLevel(minLevel)) return false;
  const sandboxId = msg["sandboxId"];

  return (
    sandboxId === undefined || (stream === "logs" && isSandboxLogId(sandboxId))
  );
}
