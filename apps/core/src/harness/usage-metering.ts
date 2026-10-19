/**
 * Per-task metering helpers. Flattens the AI SDK v7 `LanguageModelUsage`
 * shape (nested input/output token details) for span attributes and usage rows,
 * meters cache-write tokens with a providerMetadata fallback for providers
 * that only surface cache creation there, keeps one run's sandbox CPU
 * ledger for its usage row, its root span and each tool.call span, tracks
 * each model.step's timing (ttft, streaming windows, retries), sums one
 * run's token totals across its steps, and settles the run once: its root
 * span and its usage row.
 */

import {
  canonicalModelProvider,
  PROVIDER_CACHE_WRITE_FIELDS,
} from "@broods/convex/model/modelPricing";
import { SpanStatusCode, type Span } from "@opentelemetry/api";
import type { LanguageModelUsage, TextStreamPart, ToolSet } from "ai";
import type {
  ObservabilitySpanRow,
  TaskWaitingOn,
} from "../../../../packages/broods/src/observability-contracts.ts";
import { waitUntil } from "../shared/in-flight.ts";
import { redactSensitiveText } from "../shared/log.ts";
import { isPlainObject } from "../shared/object.ts";
import {
  getObservabilityContext,
  runWithObservabilityScope,
} from "../shared/otel.ts";
import type { TaskUsageInput } from "../shared/storage.ts";
import type { ModelAttempt } from "./provider.ts";
import { formatQuestionsText, type RunOpenWork } from "./questions.ts";
import type { RunSpanTracker } from "./run-spans.ts";
import type { SandboxCpuSample } from "./sandbox/types.ts";
import type { Session } from "./session.ts";

// Generated-content stream parts that count toward per-step streaming windows
// (time-to-first-token / last-token). v7 delivers every TextStreamPart to
// onChunk, so boundary, lifecycle, and post-execution parts must not qualify.
const MODEL_CONTENT_CHUNK_TYPES: ReadonlySet<TextStreamPart<ToolSet>["type"]> =
  new Set<TextStreamPart<ToolSet>["type"]>([
    "text-delta",
    "reasoning-delta",
    "tool-input-start",
    "tool-input-delta",
    "tool-call",
    "file",
  ]);
// The usage tab shows one line of it per task, and the row is kept 90 days.
const USAGE_INPUT_PREVIEW_CHARS = 160;

/** How a run settled: failed, or completed and maybe still waiting on something. */
type RunStatus = "completed" | "failed";

export interface UsageTokenTotals {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

// Absent counts read as 0 so span attributes and usage rows stay numeric.
export function usageTokenTotals(
  usage: LanguageModelUsage | undefined,
): UsageTokenTotals {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    reasoningTokens: usage?.outputTokenDetails?.reasoningTokens ?? 0,
    cachedInputTokens: usage?.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
  };
}

// Cache-write tokens for one step; 0 when the provider doesn't break them out,
// the field is absent, or metadata is missing. Never throws.
export function extractCacheWriteTokens(
  providerName: string | undefined,
  providerMetadata: Record<string, unknown> | undefined,
): number {
  if (!providerMetadata || !providerName) return 0;

  const provider = canonicalModelProvider(providerName);
  const field = PROVIDER_CACHE_WRITE_FIELDS[provider];
  if (!field) return 0;

  // providerMetadata shape: { [providerKey]: { [fieldName]: value, ... } }
  // The top-level key matches the canonical provider name (e.g. "anthropic").
  const providerBlock = providerMetadata[provider];
  if (isPlainObject(providerBlock)) {
    const val = providerBlock[field];
    if (typeof val === "number" && val > 0) return val;
  }

  // Bedrock wraps the Anthropic block under "anthropic" inside the bedrock block.
  if (provider === "bedrock") {
    const bedrockBlock = providerMetadata["bedrock"];
    if (isPlainObject(bedrockBlock)) {
      const anthropicBlock = bedrockBlock["anthropic"];
      if (isPlainObject(anthropicBlock)) {
        const val = anthropicBlock[field];
        if (typeof val === "number" && val > 0) return val;
      }
      // Also try the field directly on the bedrock block (provider SDK variation).
      const direct = bedrockBlock[field];
      if (typeof direct === "number" && direct > 0) return direct;
    }
  }

  // Google: usageMetadata lives under the "google" key.
  if (provider === "google") {
    const googleBlock = providerMetadata["google"];
    if (isPlainObject(googleBlock)) {
      const usageMeta = googleBlock["usageMetadata"];
      if (isPlainObject(usageMeta)) {
        const val = usageMeta[field];
        if (typeof val === "number" && val > 0) return val;
      }
      const direct = googleBlock[field];
      if (typeof direct === "number" && direct > 0) return direct;
    }
  }

  return 0;
}

/** One run's sandbox CPU: the tool registry writes it, spans and the usage row read it. */
export interface SandboxCpuLedger {
  /** Passed to the tool registry as `onSandboxCpu`; folds each CPU sample into the usage buckets. */
  record: (sample: SandboxCpuSample) => void;
  /** That call's compute, handed out once when its tool.call span closes. */
  takeToolCompute: (
    toolCallId: string,
  ) => Pick<SandboxCpuSample, "type" | "cpuUsec"> | undefined;
  /**
   * Sandbox CPU so far split by role (agent's own sandbox vs hosted MCP), for
   * the live root span re-published after each step. Empty until CPU arrives.
   */
  roleAttributes: () => Record<string, number>;
  /** Sandbox CPU split per provider, for the finished root span. */
  typeAttributes: () => Record<string, number>;
  /** One sandboxUsage row per (type, role, tool) bucket. */
  usage: () => SandboxCpuSample[];
}

export function createSandboxCpuLedger(): SandboxCpuLedger {
  // Accumulate sandbox CPU per (type, role, tool); each bucket becomes one
  // sandboxUsage row at finalize. CPU only arrives from sandbox execs and
  // hosted MCP calls.
  const sandboxUsageByKey = new Map<string, SandboxCpuSample>();
  // Per-call compute, so the tool.call span can report what that one call cost.
  // Keyed by call id and consumed once the span closes; usage rows stay aggregated.
  const toolComputeByCallId = new Map<
    string,
    Pick<SandboxCpuSample, "type" | "cpuUsec">
  >();

  return {
    record: (sample) => {
      if (!(sample.cpuUsec > 0)) return;
      if (sample.role === "tool" && sample.toolCallId !== undefined) {
        const call = toolComputeByCallId.get(sample.toolCallId);
        if (call) call.cpuUsec += sample.cpuUsec;
        else
          toolComputeByCallId.set(sample.toolCallId, {
            type: sample.type,
            cpuUsec: sample.cpuUsec,
          });
      }
      const key = `${sample.type}|${sample.role}|${sample.toolName ?? ""}`;
      const existing = sandboxUsageByKey.get(key);
      if (existing) {
        existing.cpuUsec += sample.cpuUsec;
      } else {
        sandboxUsageByKey.set(key, {
          type: sample.type,
          role: sample.role,
          ...(sample.toolName ? { toolName: sample.toolName } : {}),
          cpuUsec: sample.cpuUsec,
        });
      }
    },
    takeToolCompute: (toolCallId) => {
      const compute = toolComputeByCallId.get(toolCallId);
      toolComputeByCallId.delete(toolCallId);
      return compute;
    },
    roleAttributes: () => {
      let agent = 0;
      let tool = 0;
      for (const sample of sandboxUsageByKey.values()) {
        if (sample.role === "agent") agent += sample.cpuUsec;
        else if (sample.role === "tool") tool += sample.cpuUsec;
      }

      return {
        ...(agent > 0 ? { "sandbox.cpu_usec.role.agent": agent } : {}),
        ...(tool > 0 ? { "sandbox.cpu_usec.role.tool": tool } : {}),
      };
    },
    typeAttributes: () => {
      const cpuUsecByType = new Map<string, number>();
      for (const sample of sandboxUsageByKey.values()) {
        cpuUsecByType.set(
          sample.type,
          (cpuUsecByType.get(sample.type) ?? 0) + sample.cpuUsec,
        );
      }

      return Object.fromEntries(
        [...cpuUsecByType.entries()].map(([type, cpuUsec]) => [
          `sandbox.cpu_usec.${type}`,
          cpuUsec,
        ]),
      );
    },
    usage: () => [...sandboxUsageByKey.values()],
  };
}

/** First and last generated chunk of one kind in a step, in epoch ms. */
interface StreamWindow {
  first: number;
  last: number;
}

/** Everything one model.step accrues between startStep and closeStep. */
interface StepTiming {
  startedAt: number | undefined;
  // First and last generated chunk, attributed to the active step since onChunk
  // has no step number. They split the step into ttft, streaming and tool wait;
  // tool results are not generation, so a slow tool never inflates streaming.
  firstChunkAt: number | undefined;
  lastChunkAt: number | undefined;
  // Per-kind windows (first->last delta) so the dashboard can show how long the
  // model spent streaming reasoning vs text vs tool-call input. They may overlap
  // slightly for models that interleave.
  reasoning: StreamWindow | undefined;
  text: StreamWindow | undefined;
  toolInput: StreamWindow | undefined;
  // The SDK retries a failed stream start inside the ttft window with nothing
  // recorded; attemptRecordingMiddleware fills this per doStream call.
  attempts: ModelAttempt[];
}

/**
 * One run's per-step timing: `runAgentLoop` feeds it from the stream callbacks
 * and reads the step's duration attributes back when the model.step span
 * closes. Timestamps are passed in; it holds nothing but the per-step records.
 */
export interface StepTimingTracker {
  /** onStepStart: starts the step's clock and attributes chunks and attempts to it. */
  startStep: (step: number, nowMs: number) => void;
  /** The step chunks and attempts attribute to; undefined between steps. */
  activeStep: () => number | undefined;
  /** onStepEnd: stops attributing to `step` unless a newer step already took over. */
  endActiveStep: (step: number) => void;
  /** When `step` started; undefined before `startStep` and after `closeStep`. */
  stepStartMs: (step: number) => number | undefined;
  /** onChunk: a generated-content part extends the step's generation and per-kind streaming windows. */
  recordChunk: (
    chunkType: TextStreamPart<ToolSet>["type"],
    nowMs: number,
  ) => void;
  /** attemptRecordingMiddleware: one entry per doStream call of the active step. */
  recordAttempt: (attempt: ModelAttempt) => void;
  /**
   * ttft = retry_wait (failed attempts + backoff) + the final attempt's real
   * server wait, so a retried 429 is distinguishable from queueing. Read on
   * its own for a step whose every attempt failed and never reached onStepEnd.
   */
  attemptAttributes: (step: number) => Record<string, string | number>;
  /**
   * The step's span attributes: ttft, attempts, streaming, tool wait and the
   * per-kind streaming windows, each only when observed. Drops the step.
   */
  closeStep: (
    step: number,
    stepEndMs: number,
  ) => Record<string, string | number>;
  /** Drops every step once the run is finalized. */
  clear: () => void;
}

/** One run's step timing; `serialize` renders attempt errors as a span attribute. */
export function createStepTimingTracker(
  serialize: (value: unknown) => string,
): StepTimingTracker {
  const steps = new Map<number, StepTiming>();
  let activeStepNumber: number | undefined;

  const stepOf = (step: number): StepTiming => {
    const existing = steps.get(step);
    if (existing) return existing;
    const created: StepTiming = {
      startedAt: undefined,
      firstChunkAt: undefined,
      lastChunkAt: undefined,
      reasoning: undefined,
      text: undefined,
      toolInput: undefined,
      attempts: [],
    };
    steps.set(step, created);

    return created;
  };

  const attemptAttributes: StepTimingTracker["attemptAttributes"] = (step) => {
    const timing = steps.get(step);
    const attempts = timing?.attempts ?? [];
    const stepStartMs = timing?.startedAt;
    const errors = attempts.flatMap((attempt) =>
      attempt.error ? [attempt.error] : [],
    );
    const lastAttemptAt = attempts.at(-1)?.startedAt;

    return {
      ...(attempts.length > 0 ? { "model.attempts": attempts.length } : {}),
      ...(attempts.length > 1 &&
      lastAttemptAt !== undefined &&
      stepStartMs !== undefined
        ? { "model.retry_wait_ms": Math.max(0, lastAttemptAt - stepStartMs) }
        : {}),
      ...(errors.length > 0
        ? { "model.attempt_errors": serialize(errors) }
        : {}),
    };
  };

  return {
    startStep: (step, nowMs) => {
      stepOf(step).startedAt = nowMs;
      activeStepNumber = step;
    },
    activeStep: () => activeStepNumber,
    endActiveStep: (step) => {
      if (activeStepNumber === step) activeStepNumber = undefined;
    },
    stepStartMs: (step) => steps.get(step)?.startedAt,
    recordChunk: (chunkType, nowMs) => {
      // Kept synchronous and cheap: onChunk pauses the stream until it returns.
      if (!MODEL_CONTENT_CHUNK_TYPES.has(chunkType)) return;
      if (activeStepNumber === undefined) return;
      const timing = stepOf(activeStepNumber);
      timing.firstChunkAt ??= nowMs;
      timing.lastChunkAt = nowMs;
      if (chunkType === "text-delta") {
        (timing.text ??= { first: nowMs, last: nowMs }).last = nowMs;
      } else if (chunkType === "reasoning-delta") {
        (timing.reasoning ??= { first: nowMs, last: nowMs }).last = nowMs;
      } else if (
        chunkType === "tool-input-start" ||
        chunkType === "tool-input-delta" ||
        chunkType === "tool-call"
      ) {
        (timing.toolInput ??= { first: nowMs, last: nowMs }).last = nowMs;
      }
    },
    recordAttempt: (attempt) => {
      stepOf(activeStepNumber ?? 0).attempts.push(attempt);
    },
    attemptAttributes: attemptAttributes,
    closeStep: (step, stepEndMs) => {
      const timing = steps.get(step);
      const stepStartMs = timing?.startedAt;
      // Non-overlapping segments that sum to the step duration; their windows
      // are defined on StepTiming above.
      const firstTokenMs = timing?.firstChunkAt;
      const lastTokenMs = timing?.lastChunkAt ?? firstTokenMs;
      const ttftMs =
        firstTokenMs !== undefined && stepStartMs !== undefined
          ? Math.max(0, firstTokenMs - stepStartMs)
          : undefined;
      const streamMs =
        firstTokenMs !== undefined && lastTokenMs !== undefined
          ? Math.max(0, lastTokenMs - firstTokenMs)
          : undefined;
      const toolWaitMs =
        lastTokenMs !== undefined
          ? Math.max(0, stepEndMs - lastTokenMs)
          : undefined;
      const reasoningMs = windowMs(timing?.reasoning);
      const textMs = windowMs(timing?.text);
      const toolInputMs = windowMs(timing?.toolInput);
      const stepAttemptAttributes = attemptAttributes(step);
      steps.delete(step);

      return {
        ...(ttftMs !== undefined ? { "model.ttft_ms": ttftMs } : {}),
        ...stepAttemptAttributes,
        ...(streamMs !== undefined ? { "model.stream_ms": streamMs } : {}),
        ...(toolWaitMs !== undefined
          ? { "model.tool_wait_ms": toolWaitMs }
          : {}),
        ...(reasoningMs !== undefined
          ? { "model.reasoning_stream_ms": reasoningMs }
          : {}),
        ...(textMs !== undefined ? { "model.text_stream_ms": textMs } : {}),
        ...(toolInputMs !== undefined
          ? { "model.tool_input_stream_ms": toolInputMs }
          : {}),
      };
    },
    clear: () => {
      steps.clear();
      activeStepNumber = undefined;
    },
  };
}

/**
 * One run's token totals for its usage row and root span: onStepEnd adds each
 * finished step, onEnd may replace the sum with the turn total, finalize reads.
 */
export interface TaskTotals {
  /**
   * onStepEnd: folds a finished step in. An aborted run never reaches onEnd,
   * and a stopped one gets an empty total there, so finished steps are summed
   * here. `stepTokens` is the step's flattened usage, which the step span also
   * reads; `cacheWriteTokensFallback` is the providerMetadata count, metered
   * only when that usage lacks one.
   */
  addStep: (
    stepNumber: number,
    stepTokens: UsageTokenTotals,
    cacheWriteTokensFallback: number,
  ) => void;
  /**
   * onEnd: the turn total wins (a harness counts calls no step reported),
   * unless a stop thrown from prepareStep left it empty: then the step sum
   * stands. The step count is the turn's either way.
   */
  finish: (usage: LanguageModelUsage, stepCount: number) => void;
  /** Steps finished so far, or the turn's count after `finish`. */
  steps: () => number;
  /** The summed or turn usage; undefined before the first step ends. */
  usage: () => LanguageModelUsage | undefined;
  /** Cache-write tokens summed over every finished step. */
  cacheWriteTokens: () => number;
}

export function createTaskTotals(): TaskTotals {
  let usage: LanguageModelUsage | undefined;
  let steps = 0;
  let cacheWriteTokens = 0;

  return {
    addStep: (stepNumber, stepTokens, cacheWriteTokensFallback) => {
      const soFar = usageTokenTotals(usage);
      cacheWriteTokens +=
        stepTokens.cacheWriteTokens || cacheWriteTokensFallback;
      usage = {
        inputTokens: soFar.inputTokens + stepTokens.inputTokens,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens:
            soFar.cachedInputTokens + stepTokens.cachedInputTokens,
          cacheWriteTokens:
            soFar.cacheWriteTokens + stepTokens.cacheWriteTokens,
        },
        outputTokens: soFar.outputTokens + stepTokens.outputTokens,
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: soFar.reasoningTokens + stepTokens.reasoningTokens,
        },
        totalTokens: soFar.totalTokens + stepTokens.totalTokens,
      };
      steps = stepNumber + 1;
    },
    finish: (turnUsage, stepCount) => {
      if (
        Object.values(usageTokenTotals(turnUsage)).some((tokens) => tokens > 0)
      ) {
        usage = turnUsage;
      }
      steps = stepCount;
    },
    steps: () => steps,
    usage: () => usage,
    cacheWriteTokens: () => cacheWriteTokens,
  };
}

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
  /** What a run that ended cleanly still waits on, for the root's closing state. */
  openWork: (status: RunStatus) => Promise<RunOpenWork>;
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
   * Closes open spans and the root span, then writes task usage. Every call
   * after the first is a no-op.
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
  const { root, session } = inputs;
  let finalized = false;

  return {
    finalize: async (status, toolCallCount, durationMs, error) => {
      if (finalized) return;
      finalized = true;
      inputs.release();
      const taskTokens = usageTokenTotals(inputs.taskTotals.usage());
      const stepCount = inputs.taskTotals.steps();
      const { waitingOn, questions: openQuestions } =
        await inputs.openWork(status);
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
      const sandboxCpuAttributes = inputs.sandboxCpu.typeAttributes();
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
        attributes: {
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
          ...sandboxCpuAttributes,
        },
        ...(sanitizedError ? { error: sanitizedError.message } : {}),
      };

      // End the root OTel span (durable Tempo export).
      try {
        root.span.setAttributes(
          rootSpanRow.attributes as Record<
            string,
            string | number | boolean | undefined
          >,
        );
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
      try {
        // Off the turn's tail: the stream closes, takeNext and the channel reply
        // go out without waiting. Its own scope keeps this run's context, so a
        // failed write still logs with the tenant scope. Shutdown drains it.
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
              modelProvider: inputs.modelProvider ?? "unknown",
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
              runtimeMemoryMb: Math.round(
                process.memoryUsage().rss / 1024 / 1024,
              ),
              sandboxUsage: inputs.sandboxCpu.usage(),
              stepCount: stepCount,
              toolCallCount: toolCallCount,
              inputPreview: inputs.taskInput.slice(
                0,
                USAGE_INPUT_PREVIEW_CHARS,
              ),
            }),
          context,
        );
        waitUntil(Promise.allSettled([usageRecorded, rootPublished]));
      } finally {
        inputs.restoreObservabilityContext();
      }
    },
    finalized: () => finalized,
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

/** A window's length, or undefined when that kind never streamed. */
function windowMs(window: StreamWindow | undefined): number | undefined {
  return window ? Math.max(0, window.last - window.first) : undefined;
}
