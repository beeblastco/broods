import { existsSync, readFileSync } from "node:fs";
import { percentile } from "./percentile.ts";

interface StepRecord {
  eventType: "model.step.finished";
  durationMs: number;
  eventId: string;
  time: string;
  timing?: {
    "model.ttft_ms"?: number;
    "model.reasoning_stream_ms"?: number;
    "model.text_stream_ms"?: number;
  };
  // AI SDK 7 `LanguageModelUsage` as logged: cache and reasoning counts sit in the details.
  usage?: {
    inputTokens?: number | null;
    inputTokenDetails?: {
      cacheReadTokens?: number | null;
      cacheWriteTokens?: number | null;
    };
    outputTokens?: number | null;
    outputTokenDetails?: { reasoningTokens?: number | null };
  };
}

interface InvocationRecord {
  eventType: "model.invocation.finished";
  durationMs: number;
  eventId: string;
  time: string;
}

interface PreparedRecord {
  eventType: "session.context.prepared";
  durationMs: number;
  time: string;
}

type CoreRecord = StepRecord | InvocationRecord | PreparedRecord;

interface Row {
  name: string;
  values: number[];
}

/**
 * Where model turns spent their time since `sinceMs`, from core's own log: called by
 * `local:verify` after the cases, printed and added to the job summary. Empty when no
 * model call completed (a keyless run stops at the provider).
 */
export function modelTimeReport(
  coreLogPath: string,
  sinceMs: number,
): string[] {
  const records = coreRecords(coreLogPath, sinceMs);
  const steps = records.filter(
    (record): record is StepRecord =>
      record.eventType === "model.step.finished",
  );
  if (steps.length === 0) return [];
  const invocations = records.filter(
    (record): record is InvocationRecord =>
      record.eventType === "model.invocation.finished",
  );
  const prepared = records.filter(
    (record): record is PreparedRecord =>
      record.eventType === "session.context.prepared",
  );
  // Subagent and compaction steps log no turn of their own: count only steps of a logged turn.
  const turnIds = new Set(invocations.map((invocation) => invocation.eventId));
  const modelMs = sum(
    steps
      .filter((step) => turnIds.has(step.eventId))
      .map((step) => step.durationMs),
  );
  const turnMs = sum(invocations.map((invocation) => invocation.durationMs));
  const rows: Row[] = [
    {
      name: "context prepare",
      values: prepared.map((record) => record.durationMs),
    },
    { name: "model first token", values: stepValues(steps, "model.ttft_ms") },
    {
      name: "model reasoning stream",
      values: stepValues(steps, "model.reasoning_stream_ms"),
    },
    {
      name: "model text stream",
      values: stepValues(steps, "model.text_stream_ms"),
    },
    { name: "model step", values: steps.map((step) => step.durationMs) },
    {
      name: "input tokens",
      values: steps.map((step) => step.usage?.inputTokens ?? 0),
    },
    {
      name: "cache read tokens",
      values: steps.map(
        (step) => step.usage?.inputTokenDetails?.cacheReadTokens ?? 0,
      ),
    },
    {
      name: "cache write tokens",
      values: steps.map(
        (step) => step.usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
      ),
    },
    {
      name: "reasoning tokens",
      values: steps.map(
        (step) => step.usage?.outputTokenDetails?.reasoningTokens ?? 0,
      ),
    },
    {
      name: "output tokens",
      values: steps.map((step) => step.usage?.outputTokens ?? 0),
    },
    {
      name: "turn (core)",
      values: invocations.map((invocation) => invocation.durationMs),
    },
  ];
  const share = turnMs > 0 ? Math.round((100 * modelMs) / turnMs) : 0;

  return [
    "",
    `#### model time: ${steps.length} steps in ${invocations.length} turns, ${share}% of core turn time waiting on the model`,
    "",
    "| phase | p50 | p95 | n |",
    "| --- | --- | --- | --- |",
    ...rows
      .filter((row) => row.values.length > 0)
      .map(
        (row) =>
          `| ${row.name} | ${percentile(row.values, 0.5)} | ${percentile(row.values, 0.95)} | ${row.values.length} |`,
      ),
    "",
  ];
}

// Every JSON line of the core log at or after `sinceMs` that a report row reads.
function coreRecords(path: string, sinceMs: number): CoreRecord[] {
  if (!existsSync(path)) return [];

  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line): CoreRecord[] => {
      if (!line.includes('"eventType"')) return [];
      try {
        const record = JSON.parse(line) as CoreRecord;
        if (Date.parse(record.time) < sinceMs) return [];

        return [record];
      } catch {
        return [];
      }
    });
}

// One timing attribute across the steps that have it, in ms.
function stepValues(
  steps: StepRecord[],
  key: keyof NonNullable<StepRecord["timing"]>,
): number[] {
  return steps.flatMap((step): number[] => {
    const value = step.timing?.[key];

    return value === undefined ? [] : [value];
  });
}

// Sum of `values`, 0 for none.
function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
