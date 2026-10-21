/**
 * The run finalizer: a run settles once however many paths reach it, its usage
 * row and root span read the task totals and the sandbox CPU ledger, spans
 * still open close through the tracker with the run's status, and the
 * observability context the run set is restored only after everything else.
 */

import { afterEach, beforeEach, expect, it } from "bun:test";
import { context as otelContextApi, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { ObservabilitySpanRow } from "../../../packages/broods/src/observability-contracts.ts";
import {
  getObservabilityContext,
  setObservabilityContext,
} from "../src/shared/otel.ts";
import type { TaskUsageInput } from "../src/shared/storage.ts";
import type { RunOpenWork } from "../src/harness/questions.ts";
import {
  createRunFinalizer,
  type RunFinalizer,
  type RunFinalizerInputs,
} from "../src/harness/run-finalizer.ts";
import { createRunSpanTracker } from "../src/harness/run-spans.ts";
import {
  createSandboxCpuLedger,
  createStepTimingTracker,
  createTaskTotals,
  usageTokenTotals,
  type UsageTokenTotals,
} from "../src/harness/usage-metering.ts";

const TRACE_ID = "6bd69e2b2e13d333ac4ce563174ee7be";
const ROOT_SPAN_ID = "53995c3f42cd8ad8";
const STARTED_AT = 1_000_000;
const CONVERSATION_KEY = "acct:acct_1:agent:agent_1:telegram:chat";
const exporter = new InMemorySpanExporter();

/** What one finalizer under test did, in the order it did it. */
interface Recorded {
  events: string[];
  published: ObservabilitySpanRow[];
  usage: TaskUsageInput[];
  /** The trace id the usage write saw as its observability context. */
  usageTraceIds: (string | undefined)[];
  /** OTel spans already finished when the root row was published. */
  finishedAtPublish: number[];
  /** What the loop's root attributes read when the finalizer asks. */
  rootAttributes: Record<string, string>;
}

beforeEach((): void => {
  trace.disable();
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    }),
  );
  exporter.reset();
  setObservabilityContext(null);
});

afterEach((): void => {
  trace.disable();
  setObservabilityContext(null);
});

it("settles once even when finalize is called twice", async (): Promise<void> => {
  const recorded = emptyRecorded();
  const { finalizer } = runFinalizer(recorded);

  expect(finalizer.finalized()).toBe(false);
  await Promise.all([
    finalizer.finalize("completed", 0, 100),
    finalizer.finalize("failed", 0, 200, new Error("late")),
  ]);
  await finalizer.finalize("failed", 0, 300);

  expect(finalizer.finalized()).toBe(true);
  expect(recorded.events.filter((event) => event === "release")).toHaveLength(
    1,
  );
  expect(recorded.usage).toHaveLength(1);
  expect(recorded.usage[0]?.status).toBe("completed");
  expect(
    recorded.published.filter((row) => row.spanId === ROOT_SPAN_ID),
  ).toHaveLength(1);
  expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual([
    "agent.task",
  ]);
});

it("a second finalize waits for the first to finish instead of returning early", async (): Promise<void> => {
  const recorded = emptyRecorded();
  const { finalizer, inputs } = runFinalizer(recorded);
  const openWork = Promise.withResolvers<RunOpenWork>();
  inputs.openWork = (): Promise<RunOpenWork> => openWork.promise;
  const settled: string[] = [];

  const first = finalizer
    .finalize("completed", 0, 100)
    .then((): number => settled.push("first"));
  const second = finalizer
    .finalize("failed", 0, 200, new Error("late"))
    .then((): number => settled.push("second"));
  await Bun.sleep(0);

  expect(finalizer.finalized()).toBe(true);
  expect(settled).toEqual([]);
  openWork.resolve({ questions: [] });
  await Promise.all([first, second]);
  expect(settled).toEqual(["first", "second"]);
  expect(recorded.events).toEqual(["release", "publish", "usage", "restore"]);
  expect(recorded.usage[0]?.status).toBe("completed");
});

it("only the first finalize sees a failed finalization", async (): Promise<void> => {
  const recorded = emptyRecorded();
  const { finalizer, inputs } = runFinalizer(recorded);
  inputs.openWork = (): Promise<RunOpenWork> =>
    Promise.reject(new Error("open work unreadable"));

  const first = finalizer.finalize("completed", 0, 100);
  const second = finalizer.finalize("failed", 0, 200);
  const failure = await first.catch((error: unknown): unknown => error);

  expect(failure).toEqual(new Error("open work unreadable"));
  expect(await second).toBeUndefined();
  expect(recorded.events).toEqual(["release", "restore"]);
});

it("counts as finalized before its synchronous part runs", async (): Promise<void> => {
  const recorded = emptyRecorded();
  const { finalizer, inputs } = runFinalizer(recorded);
  const release = inputs.release;
  let finalizedDuringRelease = false;
  inputs.release = (): void => {
    finalizedDuringRelease = finalizer.finalized();
    release();
  };

  await finalizer.finalize("failed", 0, 100, new Error("boom"));

  expect(finalizedDuringRelease).toBe(true);
});

it("records usage and the root span from the task totals and the sandbox CPU ledger", async (): Promise<void> => {
  const recorded = emptyRecorded();
  const { finalizer, inputs } = runFinalizer(recorded);
  inputs.taskTotals.addStep(0, tokens(100, 20, 5, 3), 0);
  inputs.taskTotals.addStep(1, tokens(150, 30, 0, 0), 7);
  inputs.sandboxCpu.record({ type: "lambda", role: "agent", cpuUsec: 4_000 });
  // The loop keeps changing the root's attributes after it builds the finalizer.
  recorded.rootAttributes = { "task.tools": "bash,read" };

  await finalizer.finalize("completed", 3, 1_500);

  expect(recorded.usage).toEqual([
    {
      accountId: "acct_1",
      endpointId: "ep_1",
      agentId: "agent_1",
      principalChain: undefined,
      conversationKey: CONVERSATION_KEY,
      taskId: `evt_1#${TRACE_ID}`,
      modelProvider: "anthropic",
      modelId: "claude-haiku-5-5",
      finishedAt: STARTED_AT + 1_500,
      durationMs: 1_500,
      status: "completed",
      inputTokens: 250,
      outputTokens: 50,
      reasoningTokens: 0,
      cachedInputTokens: 5,
      cacheWriteTokens: 10,
      totalTokens: 300,
      runtimeKind: "container",
      runtimeWallMs: 1_500,
      runtimeMemoryMb: expect.any(Number),
      sandboxUsage: [{ type: "lambda", role: "agent", cpuUsec: 4_000 }],
      stepCount: 2,
      toolCallCount: 3,
      inputPreview: "x".repeat(160),
    },
  ]);
  const root = recorded.published.find((row) => row.spanId === ROOT_SPAN_ID);
  expect(root?.status).toBe("ok");
  expect(root?.endTimeMs).toBe(STARTED_AT + 1_500);
  expect(root?.attributes).toMatchObject({
    "task.tools": "bash,read",
    "task.state": "completed",
    "agent.step_count": 2,
    "agent.tool_call_count": 3,
    "usage.input_tokens": 250,
    "usage.total_tokens": 300,
    "sandbox.cpu_usec.lambda": 4_000,
  });
});

it("closes spans still open through the tracker with the run's redacted error", async (): Promise<void> => {
  const recorded = emptyRecorded();
  const { finalizer, spans } = runFinalizer(recorded);
  const step = spans.open("model.step", 0, STARTED_AT + 10, undefined, {});
  spans.open("tool.call", "call_1", STARTED_AT + 20, step, {});

  await finalizer.finalize("failed", 1, 900, new Error("model refused"));

  const closed = recorded.published.filter(
    (row) => row.status === "error" && row.spanId !== ROOT_SPAN_ID,
  );
  expect(closed.map((row) => row.name)).toEqual(["tool.call", "model.step"]);
  expect(closed.every((row) => row.endTimeMs === STARTED_AT + 900)).toBe(true);
  const root = recorded.published.find((row) => row.spanId === ROOT_SPAN_ID);
  expect(root?.status).toBe("error");
  expect(root?.error).toBe("model refused");
});

it("ends the root span, publishes it and writes usage in the run's context, then restores the context last", async (): Promise<void> => {
  const recorded = emptyRecorded();
  const { finalizer } = runFinalizer(recorded);
  setObservabilityContext({
    accountId: "acct_1",
    project: "tracy",
    stage: "development",
    endpointId: "ep_1",
    agentId: "agent_1",
    conversationKey: CONVERSATION_KEY,
    traceId: TRACE_ID,
    otelContext: otelContextApi.active(),
    secretValues: [],
  });

  await finalizer.finalize("completed", 0, 50);

  expect(recorded.events).toEqual(["release", "publish", "usage", "restore"]);
  expect(recorded.finishedAtPublish).toEqual([1]);
  expect(recorded.usageTraceIds).toEqual([TRACE_ID]);
  expect(getObservabilityContext()).toBeNull();
});

/** A blank record for one finalizer. */
function emptyRecorded(): Recorded {
  return {
    events: [],
    published: [],
    usage: [],
    usageTraceIds: [],
    finishedAtPublish: [],
    rootAttributes: {},
  };
}

/** A finalizer over real trackers whose side effects land in `recorded`. */
function runFinalizer(recorded: Recorded): {
  finalizer: RunFinalizer;
  inputs: RunFinalizerInputs;
  spans: ReturnType<typeof createRunSpanTracker>;
} {
  const publish = (row: ObservabilitySpanRow): Promise<void> => {
    if (row.spanId === ROOT_SPAN_ID) {
      recorded.events.push("publish");
      recorded.finishedAtPublish.push(exporter.getFinishedSpans().length);
    }
    recorded.published.push(row);

    return Promise.resolve();
  };
  const session = {
    accountId: "acct_1",
    agentId: "agent_1",
    conversationKey: CONVERSATION_KEY,
    endpointId: "ep_1",
    eventId: "evt_1",
    principal: undefined,
  };
  const spans = createRunSpanTracker({
    tracer: trace.getTracer("test"),
    scope: {
      accountId: "acct_1",
      project: "tracy",
      stage: "development",
      endpointId: "ep_1",
      agentId: "agent_1",
      conversationKey: CONVERSATION_KEY,
    },
    traceId: TRACE_ID,
    rootSpanId: ROOT_SPAN_ID,
    rootOtelContext: otelContextApi.active(),
    session: session,
    publish: publish,
  });
  const serialize = (value: unknown): string => JSON.stringify(value);
  const inputs: RunFinalizerInputs = {
    session: session,
    root: {
      span: trace.getTracer("test").startSpan("agent.task"),
      traceId: TRACE_ID,
      spanId: ROOT_SPAN_ID,
      name: "agent.task",
      kind: "task",
      startTimeMs: STARTED_AT,
    },
    rootAttributes: (): Record<string, string> => recorded.rootAttributes,
    modelProvider: "anthropic",
    modelId: "claude-haiku-5-5",
    taskInput: "x".repeat(500),
    serialize: serialize,
    spans: spans,
    stepTiming: createStepTimingTracker(serialize),
    taskTotals: createTaskTotals(),
    sandboxCpu: createSandboxCpuLedger(),
    openWork: (): Promise<RunOpenWork> => Promise.resolve({ questions: [] }),
    publish: publish,
    recordUsage: (input): Promise<void> => {
      recorded.events.push("usage");
      recorded.usage.push(input);
      recorded.usageTraceIds.push(getObservabilityContext()?.traceId);

      return Promise.resolve();
    },
    release: (): void => {
      recorded.events.push("release");
    },
    restoreObservabilityContext: (): void => {
      recorded.events.push("restore");
      setObservabilityContext(null);
    },
  };

  return {
    finalizer: createRunFinalizer(inputs),
    inputs: inputs,
    spans: spans,
  };
}

/** One finished step's flattened usage. */
function tokens(
  input: number,
  output: number,
  cached: number,
  cacheWrite: number,
): UsageTokenTotals {
  return usageTokenTotals({
    inputTokens: input,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: cached,
      cacheWriteTokens: cacheWrite,
    },
    outputTokens: output,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    totalTokens: input + output,
  });
}
