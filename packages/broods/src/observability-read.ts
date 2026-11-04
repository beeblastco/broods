// What an agent or a terminal needs from logs, traces and the audit ledger: the facts, not the
// hashes, ids and raw attributes a dashboard or a verifier wants.

import type {
  ObservabilityLogEntry,
  ObservabilitySpanRow,
} from "./observability-contracts.ts";

const PREVIEW_CHARS = 300;
const TOOL_PAYLOAD_CHARS = 1_000;

export interface AuditEventSummary {
  at: string;
  actor?: string | undefined;
  action: string;
  resource?: string | undefined;
  summary?: string | undefined;
  traceId?: string | undefined;
}

export interface AuditLedgerRow {
  seq: number;
  at: number;
  actor?: { agentId?: string; id?: string; kind?: string };
  action: string;
  resource?: { id?: string; kind?: string; name?: string };
  summary?: string | undefined;
  traceId?: string | undefined;
}

export interface LogLine {
  at: string;
  level: string;
  message: string;
  event: string;
  traceId?: string | undefined;
  agentId?: string | undefined;
}

export interface RunSummary {
  traceId: string;
  at: string;
  status: string;
  durationMs: number;
  agentId?: string | undefined;
  conversation?: string | undefined;
  input?: string | undefined;
  error?: string | undefined;
  steps?: number | undefined;
  toolCalls?: number | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

export interface TraceStep {
  at: string;
  kind: string;
  status: string;
  durationMs: number;
  name: string;
  error?: string | undefined;
  input?: string | undefined;
  output?: string | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  finish?: string | undefined;
}

/** Newest first, filtered, without the hash chain that only a verifier reads. */
export function auditSummaries(
  rows: readonly AuditLedgerRow[],
  filter: { agentId?: string; action?: string; limit: number },
): { matched: number; events: AuditEventSummary[] } {
  const { action, agentId, limit } = filter;
  const matches = rows
    .filter(
      (row): boolean =>
        (!agentId ||
          row.actor?.agentId === agentId ||
          row.resource?.id === agentId ||
          row.resource?.id?.includes(`:agent:${agentId}:`) === true) &&
        (!action || row.action === action),
    )
    .toReversed();

  return {
    matched: matches.length,
    events: matches.slice(0, limit).map((row): AuditEventSummary => ({
      at: new Date(row.at).toISOString(),
      action: row.action,
      actor: row.actor?.agentId ?? row.actor?.kind,
      resource: row.resource?.name ?? row.resource?.id ?? row.resource?.kind,
      summary: row.summary,
      traceId: row.traceId,
    })),
  };
}

export function logLine(entry: ObservabilityLogEntry): LogLine {
  return {
    at: new Date(entry.ts).toISOString(),
    level: entry.level,
    message: entry.message,
    event: entry.eventType,
    traceId: entry.traceId,
    agentId: entry.agentId,
  };
}

/** One line per run: its root span, newest first. */
export function runSummaries(
  spans: readonly ObservabilitySpanRow[],
  filter: { agentId?: string; status?: string; limit: number },
): RunSummary[] {
  const { agentId, limit, status } = filter;

  return spans
    .filter(
      (span): boolean =>
        (span.kind === "task" ||
          span.kind === "cron" ||
          span.kind === "subtask") &&
        (!agentId || span.agentId === agentId) &&
        (!status || span.status === status),
    )
    .toSorted((a, b): number => b.startTimeMs - a.startTimeMs)
    .slice(0, limit)
    .map((span): RunSummary => {
      const attributes = span.attributes ?? {};

      return {
        traceId: span.traceId,
        at: new Date(span.startTimeMs).toISOString(),
        status: span.status,
        durationMs: span.durationMs,
        agentId: span.agentId,
        conversation: span.conversationKey,
        input: preview(attributes["task.input"], PREVIEW_CHARS),
        error: span.error,
        steps: numeric(attributes["agent.step_count"]),
        toolCalls: numeric(attributes["agent.tool_call_count"]),
        inputTokens: numeric(attributes["usage.input_tokens"]),
        outputTokens: numeric(attributes["usage.output_tokens"]),
      };
    });
}

/** Every model step and tool call in order, with payloads cut to what a reader can use. */
export function traceSteps(
  spans: readonly ObservabilitySpanRow[],
): TraceStep[] {
  return spans
    .toSorted((a, b): number => a.startTimeMs - b.startTimeMs)
    .map((span): TraceStep => {
      const attributes = span.attributes ?? {};
      const tool = attributes["tool.name"];

      return {
        at: new Date(span.startTimeMs).toISOString(),
        kind: span.kind,
        status: span.status,
        durationMs: span.durationMs,
        name: typeof tool === "string" ? tool : span.name,
        error: span.error,
        input: preview(attributes["tool.input"], TOOL_PAYLOAD_CHARS),
        output: preview(
          attributes["tool.output"] ?? attributes["model.response"],
          TOOL_PAYLOAD_CHARS,
        ),
        inputTokens: numeric(attributes["model.input_tokens"]),
        outputTokens: numeric(attributes["model.output_tokens"]),
        finish: text(attributes["model.finish_reason"]),
      };
    });
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function preview(value: unknown, limit: number): string | undefined {
  const shown = typeof value === "string" ? value : text(value);
  if (!shown) return undefined;

  return shown.length > limit
    ? `${shown.slice(0, limit)}… [${shown.length} chars]`
    : shown;
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value;

  return value === undefined ? undefined : JSON.stringify(value);
}
