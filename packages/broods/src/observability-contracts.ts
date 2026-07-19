/**
 * Shared WebSocket wire-protocol types for the observability gateway, used by
 * the gateway, the SDK/CLI, and the dashboard. Pure types + tiny pure helpers,
 * zero runtime deps. Kept separate from the agent-test websocket-contracts.
 */

// DEBUG is durable-only (Loki/Grafana) and never sent over NATS live.
export type LogLevel = "INFO" | "WARN" | "ERROR";
export const MAX_OBSERVABILITY_BACKFILL = 500;

// Matches the shape core's _shared/log.ts emits to NATS. `level` allows DEBUG
// because Loki backfill can return it; the live NATS stream is INFO+ only.
export type ObservabilityLogEntry = {
  ts: number;
  level: LogLevel | "DEBUG";
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

// Root span kind is "task" (one per top-level invocation); a "subtask" is a
// subagent's root span. A subtask is its OWN top-level trace (its own traceId),
// linked back to the parent via the parent.trace_id / parent.task_id attributes
// rather than nested under the parent span — the dashboard renders it as a sibling
// task row with a jump-to-parent link. Children ("model.step", "tool.call", and
// "phase" timeline spans like cold start, context prepare, and compaction) share
// the traceId of the task or subtask they belong to.
export type ObservabilitySpanRow = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: "task" | "subtask" | "model.step" | "tool.call" | "phase";
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
  // Server-side min level for the live "logs" relay (default INFO+); traces are unfiltered.
  minLevel?: LogLevel;
};

export type ObservabilityUnsubscribeMessage = {
  type: "unsubscribe";
  stream: "logs" | "traces";
};

export type ObservabilityClientMessage =
  | ObservabilitySubscribeMessage
  | ObservabilityUnsubscribeMessage;

// Sent once the live NATS subscription is active and any backfill is delivered.
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
    if (
      minLevel !== undefined &&
      minLevel !== "INFO" &&
      minLevel !== "WARN" &&
      minLevel !== "ERROR"
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
