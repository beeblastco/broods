/**
 * Finalizes each agent run once. Closes its spans, publishes its root row and
 * records usage, then restores the caller's observability context on success
 * or failure.
 */

import { SpanStatusCode, type Span } from "@opentelemetry/api";
import type {
  ObservabilitySpanRow,
  TaskWaitingOn,
} from "../../../../packages/broods/src/observability-contracts.ts";
import { waitUntil } from "../shared/in-flight.ts";
import { redactSensitiveText } from "../shared/log.ts";
import {
  getObservabilityContext,
  runWithObservabilityScope,
} from "../shared/otel.ts";
import type { TaskUsageInput } from "../shared/storage.ts";
import { formatQuestionsText, type RunOpenWork } from "./questions.ts";
import type { RunSpanTracker } from "./run-spans.ts";
import type { Session } from "./session.ts";
import {
  usageTokenTotals,
  type SandboxCpuLedger,
  type StepTimingTracker,
  type TaskTotals,
} from "./usage-metering.ts";

// The usage tab shows one line of it per task, and the row is kept 90 days.
const USAGE_INPUT_PREVIEW_CHARS = 160;

type RunStatus = "completed" | "failed";

/**
 * What one run hands its finalizer up front. The getters read state the loop
 * still changes after it builds the finalizer.
 */
export interface RunFinalizerInputs {
  session: Pick<
    Session,
    | "accountId"
    | "agentId"
    | "conversationKey"
    | "endpointId"
    | "eventId"
    | "principal"
  >;
  /** The root OTel span and the fixed fields of its closing row. */
  root: Pick<
    ObservabilitySpanRow,
    "traceId" | "spanId" | "name" | "kind" | "startTimeMs"
  > & { span: Span };
  /** The live root span's attributes with the system prompt as it ended up. */
  rootAttributes: () => Record<string, string | number | boolean>;
  modelProvider: string;
  modelId: string | undefined;
  /** The run's request text as Tracing labels it; its head previews the usage row. */
  taskInput: string;
  /** Serializes a span attribute with run secrets redacted. */
  serialize: (value: unknown) => string;
  spans: Pick<RunSpanTracker, "closeOrphans">;
  stepTiming: Pick<StepTimingTracker, "attemptAttributes" | "clear">;
  taskTotals: TaskTotals;
  sandboxCpu: SandboxCpuLedger;
  /** What a run that ended cleanly still waits on, for the root's closing state; not read for a failed run. */
  openWork: () => Promise<RunOpenWork>;
  /** Publishes the root row to the live trace stream; tracked for shutdown. */
  publish: (row: ObservabilitySpanRow) => Promise<void>;
  /** Writes the usage row; runs off the turn's tail in the run's own scope. */
  recordUsage: (input: TaskUsageInput) => Promise<void>;
  /** Runs first: drops the abort listener and the run's sandbox occupancy. */
  release: () => void;
  /** Runs last: the process is reused, so no run's tenant, trace or secrets outlive it. */
  restoreObservabilityContext: () => void;
}

/** Settles one run exactly once, whichever of onEnd, a failure or `ensureFinalized` gets there first. */
export interface RunFinalizer {
  /**
   * Closes open spans and the root span, then writes task usage. A call after
   * the first ignores its arguments, waits for the first, and never rejects:
   * only the first caller sees a failed finalization.
   */
  finalize: (
    status: RunStatus,
    toolCallCount: number,
    durationMs: number,
    error?: Error,
  ) => Promise<void>;
  /** True once `finalize` has started. */
  finalized: () => boolean;
}

/**
 * Built once per run by runAgentLoop, after the root span and the run's
 * trackers exist. Usage comes from the task totals and the sandbox CPU ledger.
 */
export function createRunFinalizer(inputs: RunFinalizerInputs): RunFinalizer {
  let settling: Promise<void> | undefined;

  return {
    finalize: (status, toolCallCount, durationMs, error): Promise<void> => {
      if (settling) return settling.catch((): void => {});
      // Marked started before the settle runs, as its synchronous part
      // (release, span end, publish) must never see the run unsettled.
      const first = Promise.withResolvers<void>();
      settling = first.promise;
      void settleRun(inputs, status, toolCallCount, durationMs, error)
        .finally((): void => inputs.restoreObservabilityContext())
        .then(first.resolve, first.reject);

      return settling;
    },
    finalized: (): boolean => settling !== undefined,
  };
}

/** The root's closing status: a clean run that left something open waits on it. */
function rootSpanStatus(
  status: RunStatus,
  waitingOn: TaskWaitingOn | undefined,
): ObservabilitySpanRow["status"] {
  if (status === "failed") return "error";
  if (!waitingOn) return "ok";

  return waitingOn === "question" || waitingOn === "approval"
    ? "needs_input"
    : "waiting";
}

/** The run's one finalization; `finalize` hands its promise to every caller. */
async function settleRun(
  inputs: RunFinalizerInputs,
  status: RunStatus,
  toolCallCount: number,
  durationMs: number,
  error: Error | undefined,
): Promise<void> {
  const { root, session } = inputs;
  inputs.release();
  const taskTokens = usageTokenTotals(inputs.taskTotals.usage());
  const stepCount = inputs.taskTotals.steps();
  const { waitingOn, questions: openQuestions }: RunOpenWork =
    status === "failed" ? { questions: [] } : await inputs.openWork();
  const rootStatus = rootSpanStatus(status, waitingOn);

  const context = getObservabilityContext();
  const sanitizedError = error
    ? new Error(redactSensitiveText(error.message, context?.secretValues))
    : undefined;

  const endTimeMs = root.startTimeMs + durationMs;
  inputs.spans.closeOrphans(
    endTimeMs,
    status,
    sanitizedError?.message,
    inputs.stepTiming.attemptAttributes,
  );
  inputs.stepTiming.clear();
  // Task totals on the root span: token usage and sandbox CPU split per provider
  // so the dashboard reads final usage straight off the trace stream.
  const attributes: Record<string, string | number | boolean | undefined> = {
    ...inputs.rootAttributes(),
    ...(waitingOn
      ? { "task.state": rootStatus, "task.waiting_on": waitingOn }
      : { "task.state": status }),
    ...(openQuestions.length > 0
      ? {
          "task.questions": inputs.serialize(
            formatQuestionsText(openQuestions),
          ),
        }
      : {}),
    "agent.step_count": stepCount,
    "agent.tool_call_count": toolCallCount,
    "agent.model_provider": inputs.modelProvider,
    "agent.model_id": inputs.modelId,
    "usage.input_tokens": taskTokens.inputTokens,
    "usage.output_tokens": taskTokens.outputTokens,
    "usage.reasoning_tokens": taskTokens.reasoningTokens,
    "usage.cached_input_tokens": taskTokens.cachedInputTokens,
    "usage.total_tokens": taskTokens.totalTokens,
    ...inputs.sandboxCpu.typeAttributes(),
  };
  const rootSpanRow: ObservabilitySpanRow = {
    traceId: root.traceId,
    spanId: root.spanId,
    name: root.name,
    kind: root.kind,
    startTimeMs: root.startTimeMs,
    endTimeMs: endTimeMs,
    durationMs: durationMs,
    status: rootStatus,
    endpointId: session.endpointId,
    agentId: session.agentId,
    conversationKey: session.conversationKey,
    attributes: attributes,
    ...(sanitizedError ? { error: sanitizedError.message } : {}),
  };

  // End the root OTel span (durable Tempo export).
  try {
    root.span.setAttributes(attributes);
    if (status === "failed") {
      if (sanitizedError) root.span.recordException(sanitizedError);
      root.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: sanitizedError?.message,
      });
    } else {
      root.span.setStatus({ code: SpanStatusCode.OK });
    }
    root.span.end(endTimeMs);
  } catch {
    // Best-effort: never fail the agent path.
  }

  // Live publish via NATS, tracked with the usage write so shutdown drains the
  // terminal span. Otherwise a fresh dashboard load can keep a stale "running"
  // copy of an already-finished task.
  const rootPublished = inputs.publish(rootSpanRow);
  // The run's scope follows the background usage write after the response closes.
  // Shutdown drains both writes before the process exits.
  const usageRecorded = runWithObservabilityScope(
    () =>
      inputs.recordUsage({
        accountId: session.accountId ?? "",
        endpointId: session.endpointId,
        agentId: session.agentId ?? "unknown",
        principalChain: session.principal?.chain,
        conversationKey: session.conversationKey,
        // One row per model pass: a continuation pass shares the eventId.
        taskId: `${session.eventId}#${root.traceId}`,
        modelProvider: inputs.modelProvider,
        modelId: inputs.modelId ?? "unknown",
        finishedAt: endTimeMs,
        durationMs: durationMs,
        status: status,
        inputTokens: taskTokens.inputTokens,
        outputTokens: taskTokens.outputTokens,
        reasoningTokens: taskTokens.reasoningTokens,
        cachedInputTokens: taskTokens.cachedInputTokens,
        cacheWriteTokens: inputs.taskTotals.cacheWriteTokens(),
        totalTokens: taskTokens.totalTokens,
        runtimeKind: "container",
        runtimeWallMs: durationMs,
        // The pod is shared by every run, so this is its resident size when the
        // run ended, not memory the run owned.
        runtimeMemoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        sandboxUsage: inputs.sandboxCpu.usage(),
        stepCount: stepCount,
        toolCallCount: toolCallCount,
        inputPreview: inputs.taskInput.slice(0, USAGE_INPUT_PREVIEW_CHARS),
      }),
    context,
  );
  waitUntil(Promise.allSettled([usageRecorded, rootPublished]));
}
