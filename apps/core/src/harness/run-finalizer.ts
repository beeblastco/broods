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

const USAGE_INPUT_PREVIEW_CHARS = 160;

type RunStatus = "completed" | "failed";

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
  root: Pick<
    ObservabilitySpanRow,
    "traceId" | "spanId" | "name" | "kind" | "startTimeMs"
  > & { span: Span };
  rootAttributes: () => Record<string, string | number | boolean>;
  modelProvider: string;
  modelId: string | undefined;
  taskInput: string;
  serialize: (value: unknown) => string;
  spans: Pick<RunSpanTracker, "closeOrphans">;
  stepTiming: Pick<StepTimingTracker, "attemptAttributes" | "clear">;
  taskTotals: TaskTotals;
  sandboxCpu: SandboxCpuLedger;
  openWork: () => Promise<RunOpenWork>;
  publish: (row: ObservabilitySpanRow) => Promise<void>;
  recordUsage: (input: TaskUsageInput) => Promise<void>;
  release: () => void;
  // Runs last: the process is reused, so no run's tenant, trace or secrets may outlive it.
  restoreObservabilityContext: () => void;
}

export interface RunFinalizer {
  // A later call ignores its arguments and never rejects: only the first caller sees a failure.
  finalize: (
    status: RunStatus,
    toolCallCount: number,
    durationMs: number,
    error?: Error,
  ) => Promise<void>;
  finalized: () => boolean;
}

export function createRunFinalizer(inputs: RunFinalizerInputs): RunFinalizer {
  let settling: Promise<void> | undefined;

  return {
    finalize: (status, toolCallCount, durationMs, error): Promise<void> => {
      if (settling) return settling.catch((): void => {});
      // Set before settleRun starts: its synchronous part must never see the run unsettled.
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
  } catch {}

  const rootPublished = inputs.publish(rootSpanRow);
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
        // The pod's resident size at the run's end: every run shares the pod.
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
