import { expect, test } from "bun:test";
import type * as OtelApi from "@opentelemetry/api";
import type { ObservabilitySpanRow } from "../../../../packages/broods/src/observability-contracts.ts";
import { createRunSpanTracker } from "../../../../apps/core/src/harness/run-spans.ts";

const CORE_DIR = `${import.meta.dir}/../../../../apps/core/src/harness`;
const { context: otelContextApi, trace } = (await import(
  Bun.resolveSync("@opentelemetry/api", CORE_DIR)
)) as typeof OtelApi;
const TRACE_ID = "6bd69e2b2e13d333ac4ce563174ee7be";
const ROOT_SPAN_ID = "53995c3f42cd8ad8";

test("phases under a tracer that hands out zero ids take the run's trace id and a minted span id", () => {
  trace.disable();
  const published: ObservabilitySpanRow[] = [];
  const spans = createRunSpanTracker({
    tracer: trace.getTracer("noop"),
    scope: {
      accountId: "acct_1",
      project: "support",
      stage: "development",
      endpointId: "ep_1",
      agentId: "agent_1",
      conversationKey: "acct:acct_1:agent:agent_1:slack:C1",
    },
    traceId: TRACE_ID,
    rootSpanId: ROOT_SPAN_ID,
    rootOtelContext: otelContextApi.active(),
    session: {
      endpointId: "ep_1",
      agentId: "agent_1",
      conversationKey: "acct:acct_1:agent:agent_1:slack:C1",
    },
    publish: (row): Promise<void> => {
      published.push(row);

      return Promise.resolve();
    },
  });

  spans.phase("phase.cold_start", "Cold start", 500, 900);
  spans.phase("phase.context_prepare", "Context prepare", 1_000, 1_250, {
    "context.messages": 4,
  });
  spans.phase("phase.clock_skew", "Clock skew", 2_000, 1_900);

  expect(published.map((row) => row.traceId)).toEqual([
    TRACE_ID,
    TRACE_ID,
    TRACE_ID,
  ]);
  expect(new Set(published.map((row) => row.spanId)).size).toBe(3);
  expect(published.map((row) => row.durationMs)).toEqual([400, 250, 0]);
  expect(published[1]?.attributes).toEqual({
    "phase.name": "Context prepare",
    "phase.duration_ms": 250,
    "context.messages": 4,
  });
  expect(published.every((row) => row.parentSpanId === ROOT_SPAN_ID)).toBe(
    true,
  );
});
