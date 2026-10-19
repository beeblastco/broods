/**
 * The run span tracker: a model.step or tool.call keeps one span id from its
 * running row to its closed row, orphans close with the run's status, a noop
 * tracer still yields ids, phases are best-effort, and retries land on the
 * tool that waited.
 */

import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  context as otelContextApi,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { ObservabilitySpanRow } from "../../../packages/broods/src/observability-contracts.ts";
import {
  createRunSpanTracker,
  type RunSpanIdentity,
  type RunSpanTracker,
} from "../src/harness/run-spans.ts";

const TRACE_ID = "6bd69e2b2e13d333ac4ce563174ee7be";
const ROOT_SPAN_ID = "53995c3f42cd8ad8";
const exporter = new InMemorySpanExporter();

/** Rows the tracker published, with how many OTel spans had already finished when each went out. */
type PublishedRow = { row: ObservabilitySpanRow; finishedSpans: number };

beforeEach(() => {
  trace.disable();
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    }),
  );
  exporter.reset();
});

afterEach(() => trace.disable());

/** A tracker on the global tracer whose rows land in `published`. */
function tracker(
  published: PublishedRow[],
  overrides: Partial<RunSpanIdentity> = {},
): RunSpanTracker {
  return createRunSpanTracker({
    tracer: trace.getTracer("test"),
    scope: {
      accountId: "acct_1",
      project: "tracy",
      stage: "development",
      endpointId: "ep_1",
      agentId: "agent_1",
      conversationKey: "acct:acct_1:agent:agent_1:telegram:chat",
    },
    traceId: TRACE_ID,
    rootSpanId: ROOT_SPAN_ID,
    rootOtelContext: otelContextApi.active(),
    session: {
      endpointId: "ep_1",
      agentId: "agent_1",
      conversationKey: "acct:acct_1:agent:agent_1:telegram:chat",
    },
    publish: (row) => {
      published.push({
        row: row,
        finishedSpans: exporter.getFinishedSpans().length,
      });

      return Promise.resolve();
    },
    ...overrides,
  });
}

it("keeps one span id from the running row to the closed row, ending OTel first", () => {
  const published: PublishedRow[] = [];
  const spans = tracker(published);

  const step = spans.open("model.step", 0, 1_000, undefined, {
    "agent.step_number": 0,
    "step.state": "running",
  });
  const tool = spans.open("tool.call", "call_1", 1_100, step, {
    "tool.name": "bash",
    "tool.call_id": "call_1",
    "tool.state": "running",
  });
  spans.close(tool, 1_400, "ok", { "tool.state": "completed" });
  spans.close(step, 1_500, "ok", { "step.state": "completed" });

  const [stepRunning, toolRunning, toolClosed, stepClosed] = published;
  expect(toolRunning?.row.spanId).toBe(toolClosed?.row.spanId ?? "");
  expect(stepRunning?.row.spanId).toBe(stepClosed?.row.spanId ?? "");
  expect(toolRunning?.row.parentSpanId).toBe(step.spanId);
  expect(stepRunning?.row.parentSpanId).toBe(ROOT_SPAN_ID);
  expect(toolClosed?.row).toMatchObject({
    name: "tool.call",
    kind: "tool.call",
    startTimeMs: 1_100,
    endTimeMs: 1_400,
    durationMs: 300,
    status: "ok",
    endpointId: "ep_1",
    agentId: "agent_1",
    attributes: {
      "tool.name": "bash",
      "tool.call_id": "call_1",
      "tool.state": "completed",
    },
  });
  // The OTel span ends before its row publishes: one more finished span per closed row.
  expect(toolRunning?.finishedSpans).toBe(0);
  expect(toolClosed?.finishedSpans).toBe(1);
  expect(stepClosed?.finishedSpans).toBe(2);
  expect(spans.get("call_1")).toBeUndefined();
  expect(spans.get(0)).toBeUndefined();

  const [toolSpan] = exporter.getFinishedSpans();
  expect(toolSpan?.spanContext().spanId).toBe(tool.spanId);
  expect(toolSpan?.attributes).toMatchObject({
    account_id: "acct_1",
    "tool.duration_ms": 300,
    "tool.success": true,
    "tool.state": "completed",
  });
});

it("records a failed tool call as the span's exception and the row's error", () => {
  const published: PublishedRow[] = [];
  const spans = tracker(published);
  const tool = spans.open("tool.call", "call_1", 1_000, undefined, {
    "tool.name": "bash",
    "tool.call_id": "call_1",
    "tool.state": "running",
  });

  spans.close(tool, 1_250, "error", { "tool.state": "failed" }, "exit 1");

  expect(published[1]?.row).toMatchObject({
    status: "error",
    error: "exit 1",
    attributes: { "tool.state": "failed" },
  });
  const [span] = exporter.getFinishedSpans();
  expect(span?.status).toEqual({
    code: SpanStatusCode.ERROR,
    message: "exit 1",
  });
  expect(span?.events.map((event) => event.name)).toEqual(["exception"]);
});

it("closes orphans with the run's error and the step's extra attributes", () => {
  const published: PublishedRow[] = [];
  const spans = tracker(published);
  spans.open("model.step", 2, 1_000, undefined, {
    "agent.step_number": 2,
    "step.state": "running",
  });
  spans.open("tool.call", "call_9", 1_100, spans.get(2), {
    "tool.name": "bash",
    "tool.state": "running",
  });

  spans.closeOrphans(5_000, "failed", "model timed out", (stepNumber) => ({
    "model.attempts": stepNumber + 1,
  }));

  const closed = published.slice(2).map((entry) => entry.row);
  expect(closed.map((row) => row.name)).toEqual(["tool.call", "model.step"]);
  expect(closed[0]).toMatchObject({
    status: "error",
    error: "model timed out",
    endTimeMs: 5_000,
    durationMs: 3_900,
    attributes: { "tool.name": "bash", "tool.state": "failed" },
  });
  expect(closed[1]).toMatchObject({
    status: "error",
    error: "model timed out",
    attributes: {
      "agent.step_number": 2,
      "model.attempts": 3,
      "step.state": "failed",
    },
  });
  expect(closed[1]?.attributes).not.toHaveProperty("tool.state");
  expect(spans.get(2)).toBeUndefined();
  expect(spans.get("call_9")).toBeUndefined();
  for (const span of exporter.getFinishedSpans()) {
    expect(span.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: "model timed out",
    });
  }
});

it("mints ids under a noop tracer whose span ids are all zero", () => {
  trace.disable();
  const published: PublishedRow[] = [];
  const spans = tracker(published, { tracer: trace.getTracer("noop") });

  const tool = spans.open("tool.call", "call_1", 1_000, undefined, {
    "tool.name": "bash",
  });
  spans.phase("phase.cold_start", "Cold start", 500, 900);

  expect(tool.spanId).toMatch(/^[0-9a-f]{16}$/);
  expect(tool.spanId).not.toMatch(/^0+$/);
  expect(tool.traceId).toBe(TRACE_ID);
  const phaseRow = published[1]?.row;
  expect(phaseRow?.traceId).toBe(TRACE_ID);
  expect(phaseRow?.spanId).toMatch(/^[0-9a-f]{16}$/);
  expect(phaseRow?.spanId).not.toMatch(/^0+$/);
  expect(phaseRow?.parentSpanId).toBe(ROOT_SPAN_ID);
});

it("publishes a phase as a closed row and never throws when publish fails", () => {
  const published: PublishedRow[] = [];
  const spans = tracker(published);
  spans.phase("phase.context_prepare", "Context prepare", 1_000, 1_250, {
    "prepare.history_ms": 40,
  });

  expect(published[0]?.row).toMatchObject({
    parentSpanId: ROOT_SPAN_ID,
    name: "phase.context_prepare",
    kind: "phase",
    startTimeMs: 1_000,
    endTimeMs: 1_250,
    durationMs: 250,
    status: "ok",
    attributes: {
      "phase.name": "Context prepare",
      "phase.duration_ms": 250,
      "prepare.history_ms": 40,
    },
  });
  expect(published[0]?.finishedSpans).toBe(1);

  const rejected = Promise.reject(new Error("nats down"));
  rejected.catch(() => undefined);
  const rejecting = tracker([], { publish: () => rejected });
  expect(() =>
    rejecting.phase("phase.compaction", "Compaction", 1_000, 1_100),
  ).not.toThrow();
  const throwing = tracker([], {
    publish: () => {
      throw new Error("nats down");
    },
  });
  expect(() =>
    throwing.phase("phase.compaction", "Compaction", 1_000, 1_100),
  ).not.toThrow();
});

it("tallies each retry wait on the tool that waited", () => {
  const published: PublishedRow[] = [];
  const spans = tracker(published);
  const slow = spans.open("tool.call", "call_slow", 1_000, undefined, {
    "tool.name": "web_fetch",
  });
  const quick = spans.open("tool.call", "call_quick", 1_000, undefined, {
    "tool.name": "bash",
  });
  const runningAttributes = slow.attributes;

  spans.retry("call_slow", 200);
  spans.retry("call_slow", 800);
  spans.retry("call_missing", 50);
  spans.close(slow, 3_000, "ok", { "tool.state": "completed" });
  spans.close(quick, 1_100, "ok", { "tool.state": "completed" });

  expect(runningAttributes).toEqual({ "tool.name": "web_fetch" });
  expect(published[2]?.row.attributes).toEqual({
    "tool.name": "web_fetch",
    "tool.retry.count": 2,
    "tool.retry.wait_ms": 1_000,
    "tool.state": "completed",
  });
  expect(published[3]?.row.attributes).toEqual({
    "tool.name": "bash",
    "tool.state": "completed",
  });
  const slowSpan = exporter
    .getFinishedSpans()
    .find((span) => span.spanContext().spanId === slow.spanId);
  expect(slowSpan?.attributes).toMatchObject({
    "tool.retry.count": 2,
    "tool.retry.wait_ms": 1_000,
  });
});
