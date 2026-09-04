/**
 * Shared WebSocket wire-protocol types for the observability gateway, used by
 * the gateway, the SDK/CLI, and the dashboard. Pure types + tiny pure helpers,
 * zero runtime deps. Kept separate from the agent-test websocket-contracts.
 */

// DEBUG never rides the live NATS relay — core writes it to stdout/OTLP only —
// so it reaches a client through Loki backfill and nowhere else.
export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
export const MAX_OBSERVABILITY_BACKFILL = 500;
// The per-launch UUID core puts last in a MicroVM's CloudWatch log stream name.
const SANDBOX_LOG_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Matches the shape core's shared/log.ts emits. Backfilled entries can be any
// level; the live NATS stream is INFO+ only.
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
  // Already redacted at the log.ts boundary.
  data?: unknown;
};

// Root span kind is "task" (one per top-level invocation), "cron" when the
// scheduler started that invocation instead of a person, or "subtask" for a
// subagent's root span. A subtask is its OWN top-level trace (its own traceId),
// linked back to the parent via the parent.trace_id / parent.task_id attributes
// rather than nested under the parent span — the dashboard renders it as a sibling
// task row with a jump-to-parent link. Children ("model.step", "tool.call", and
// "phase" timeline spans like cold start, context prepare, and compaction) share
// the traceId of the root they belong to.
export type ObservabilitySpanRow = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: "task" | "cron" | "subtask" | "model.step" | "tool.call" | "phase";
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  status: "running" | "ok" | "error";
  endpointId?: string;
  agentId?: string;
  conversationKey?: string;
  attributes?: Record<string, unknown>;
  error?: string;
};

export type ObservabilitySubscribeMessage = {
  type: "subscribe";
  stream: "logs" | "traces";
  // Loki/Tempo backfill of up to this many recent entries before going live.
  backfill?: number;
  // Skip JetStream replay and subscribe only to entries published after this
  // subscription starts. Used by CLI live tails so stale errors never print on
  // startup; dashboard views omit it to keep the recent full-fidelity replay.
  liveOnly?: boolean;
  // Server-side min level for the "logs" stream, applied to both the backfill
  // and the live relay (default INFO+). Pass "DEBUG" to keep backfilled debug
  // lines. Traces are unfiltered.
  minLevel?: LogLevel;
  // "logs" only: tail one sandbox's guest output instead of the deployment's own
  // logs. The id is the last segment of the instance's `logStream`, a UUID core
  // minted at launch. Sandbox lines reach Loki through the CloudWatch bridge and
  // never NATS, so the gateway serves this subscription by polling Loki.
  sandboxId?: string;
};

export type ObservabilityUnsubscribeMessage = {
  type: "unsubscribe";
  stream: "logs" | "traces";
};

export type ObservabilityClientMessage =
  | ObservabilitySubscribeMessage
  | ObservabilityUnsubscribeMessage;

// Sent once the live subscription (NATS relay, or the Loki poll of a sandbox
// tail) is active and any backfill is delivered.
export type ObservabilityReadyMessage = { type: "ready" };

export type ObservabilityBackfillMessage = {
  type: "backfill";
  stream: "logs" | "traces";
  entries: ObservabilityLogEntry[] | ObservabilitySpanRow[];
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

export function isObservabilityClientMessage(
  v: unknown,
): v is ObservabilityClientMessage {
  if (typeof v !== "object" || v === null) return false;
  const msg = v as Record<string, unknown>;
  if (msg["type"] === "subscribe") {
    const stream = msg["stream"];
    if (stream !== "logs" && stream !== "traces") return false;
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
    if (
      sandboxId !== undefined &&
      (stream !== "logs" || !isSandboxLogId(sandboxId))
    )
      return false;

    return true;
  }
  if (msg["type"] === "unsubscribe") {
    const stream = msg["stream"];

    return stream === "logs" || stream === "traces";
  }

  return false;
}

/** Narrow an unknown wire value to a LogLevel. */
export function isLogLevel(value: unknown): value is LogLevel {
  return (
    value === "DEBUG" ||
    value === "INFO" ||
    value === "WARN" ||
    value === "ERROR"
  );
}

/** Whether a span is a top-level run, each of which owns its own trace. */
export function isRootSpanKind(kind: ObservabilitySpanRow["kind"]): boolean {
  return kind === "task" || kind === "cron" || kind === "subtask";
}

/**
 * Narrow a wire value to a sandbox log id. Strict on purpose: the gateway
 * interpolates it into LogQL, so only the UUID shape core mints may pass.
 */
export function isSandboxLogId(value: unknown): value is string {
  return typeof value === "string" && SANDBOX_LOG_ID_PATTERN.test(value);
}
