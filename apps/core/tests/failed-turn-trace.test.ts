/**
 * A turn that dies before the agent loop opens its root span still leaves a
 * failed task on the trace id its log lines carry, so "View trace" finds it.
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
import { recordFailedTurn } from "../src/harness/harness.ts";
import { Session } from "../src/harness/session.ts";
import {
  runWithObservabilityScope,
  setObservabilityContext,
} from "../src/shared/otel.ts";

const TRACE_ID = "6bd69e2b2e13d333ac4ce563174ee7be";
const exporter = new InMemorySpanExporter();

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

it("records a failed task on the trace id the turn's logs carry", async () => {
  const session = new Session({
    eventId: "event-1",
    conversationKey: "acct:acct_1:agent:agent_1:telegram:chat",
    accountId: "acct_1",
    agentId: "agent_1",
    endpointId: "ep_1",
    projectSlug: "tracy",
    stageSlug: "development",
  });
  const startedAt = Date.now() - 250;

  await runWithObservabilityScope(async () => {
    setObservabilityContext({
      accountId: "acct_1",
      project: "tracy",
      stage: "development",
      endpointId: "ep_1",
      agentId: "agent_1",
      conversationKey: session.conversationKey,
      traceId: TRACE_ID,
      // No live span: the id was minted for the logs alone.
      otelContext: otelContextApi.active(),
      secretValues: ["s3cret"],
    });
    recordFailedTurn(
      session,
      startedAt,
      new Error("ArgumentValidationError with s3cret inside"),
    );
  });

  const [span] = exporter.getFinishedSpans();
  expect(span?.name).toBe("agent.task");
  expect(span?.spanContext().traceId).toBe(TRACE_ID);
  expect(span?.status).toEqual({
    code: SpanStatusCode.ERROR,
    message: "ArgumentValidationError with [redacted] inside",
  });
  expect(span?.attributes).toMatchObject({
    account_id: "acct_1",
    project: "tracy",
    stage: "development",
    "task.state": "failed",
  });
});
