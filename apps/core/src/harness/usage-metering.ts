/**
 * Per-task metering helpers. Flattens the AI SDK v7 `LanguageModelUsage`
 * shape (nested input/output token details) for span attributes and usage rows,
 * meters cache-write tokens with a providerMetadata fallback for providers
 * that only surface cache creation there, keeps one run's sandbox CPU
 * ledger for its usage row, its root span and each tool.call span, tracks
 * each model.step's timing (ttft, streaming windows, retries), and sums one
 * run's token totals across its steps.
 */

import {
  canonicalModelProvider,
  PROVIDER_CACHE_WRITE_FIELDS,
} from "@broods/convex/model/modelPricing";
import type { LanguageModelUsage } from "ai";
import { isPlainObject } from "../shared/object.ts";
import type { ModelAttempt } from "./provider.ts";
import type { SandboxCpuSample } from "./sandbox/types.ts";

// Generated-content stream parts that count toward per-step streaming windows
// (time-to-first-token / last-token). v7 delivers every TextStreamPart to
// onChunk, so boundary, lifecycle, and post-execution parts must not qualify.
const MODEL_CONTENT_CHUNK_TYPES: ReadonlySet<string> = new Set([
  "text-delta",
  "reasoning-delta",
  "tool-input-start",
  "tool-input-delta",
  "tool-call",
  "file",
]);

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

/**
 * One run's per-step timing: `runAgentLoop` feeds it from the stream callbacks
 * and reads the step's duration attributes back when the model.step span
 * closes. Timestamps are passed in; it holds nothing but the per-step maps.
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
  recordChunk: (chunkType: string, nowMs: number) => void;
  /** attemptRecordingMiddleware: one entry per doStream call of the active step. */
  recordAttempt: (attempt: ModelAttempt) => void;
  /**
   * ttft = retry_wait (failed attempts + backoff) + the final attempt's real
   * server wait, so a retried 429 is distinguishable from queueing. Read on
   * its own for a step whose every attempt failed and never reached onStepEnd.
   */
  attemptAttributes: (
    step: number,
    stepStartMs: number,
    serialize: (value: unknown) => string,
  ) => Record<string, string | number>;
  /**
   * The step's span attributes: ttft, attempts, streaming, tool wait and the
   * per-kind streaming windows, each only when observed. Clears that step's
   * state.
   */
  closeStep: (
    step: number,
    stepStartMs: number,
    stepEndMs: number,
    serialize: (value: unknown) => string,
  ) => Record<string, string | number>;
  /** Drops every step's state once the run is finalized. */
  clear: () => void;
}

export function createStepTimingTracker(): StepTimingTracker {
  // Per-step timing state, read when each step's span closes.
  const stepStartedAt = new Map<number, number>();
  // First and last generated chunk per step, attributed to the active step since
  // onChunk has no step number. They split a step into ttft, streaming and tool
  // wait; tool results are not generation, so a slow tool never inflates streaming.
  const firstChunkAt = new Map<number, number>();
  const lastModelChunkAt = new Map<number, number>();
  // Per-part streaming windows (first/last delta per kind) so the dashboard can show
  // how long the model spent streaming reasoning vs text vs tool-call input. Windows
  // are first->last per kind and may overlap slightly for models that interleave.
  const reasoningWindow = new Map<number, StreamWindow>();
  const textWindow = new Map<number, StreamWindow>();
  const toolInputWindow = new Map<number, StreamWindow>();
  // The SDK retries a failed stream start inside the ttft window with nothing
  // recorded; attemptRecordingMiddleware fills this per doStream call.
  const stepAttempts = new Map<number, ModelAttempt[]>();
  let activeStepNumber: number | undefined;

  const attemptAttributes: StepTimingTracker["attemptAttributes"] = (
    step,
    stepStartMs,
    serialize,
  ) => {
    const attempts = stepAttempts.get(step) ?? [];
    const errors = attempts.flatMap((attempt) =>
      attempt.error ? [attempt.error] : [],
    );
    const lastAttemptAt = attempts.at(-1)?.startedAt;

    return {
      ...(attempts.length > 0 ? { "model.attempts": attempts.length } : {}),
      ...(attempts.length > 1 && lastAttemptAt !== undefined
        ? { "model.retry_wait_ms": Math.max(0, lastAttemptAt - stepStartMs) }
        : {}),
      ...(errors.length > 0
        ? { "model.attempt_errors": serialize(errors) }
        : {}),
    };
  };

  return {
    startStep: (step, nowMs) => {
      stepStartedAt.set(step, nowMs);
      activeStepNumber = step;
    },
    activeStep: () => activeStepNumber,
    endActiveStep: (step) => {
      if (activeStepNumber === step) activeStepNumber = undefined;
    },
    stepStartMs: (step) => stepStartedAt.get(step),
    recordChunk: (chunkType, nowMs) => {
      if (!MODEL_CONTENT_CHUNK_TYPES.has(chunkType)) return;
      const step = activeStepNumber;
      if (step === undefined) return;
      if (!firstChunkAt.has(step)) firstChunkAt.set(step, nowMs);
      lastModelChunkAt.set(step, nowMs);
      const bump = (windows: Map<number, StreamWindow>): void => {
        const existing = windows.get(step);
        if (existing) existing.last = nowMs;
        else windows.set(step, { first: nowMs, last: nowMs });
      };
      if (chunkType === "text-delta") {
        bump(textWindow);
      } else if (chunkType === "reasoning-delta") {
        bump(reasoningWindow);
      } else if (
        chunkType === "tool-input-start" ||
        chunkType === "tool-input-delta" ||
        chunkType === "tool-call"
      ) {
        bump(toolInputWindow);
      }
    },
    recordAttempt: (attempt) => {
      const step = activeStepNumber ?? 0;
      stepAttempts.set(step, [...(stepAttempts.get(step) ?? []), attempt]);
    },
    attemptAttributes: attemptAttributes,
    closeStep: (step, stepStartMs, stepEndMs, serialize) => {
      // Non-overlapping segments that sum to the step duration; their windows
      // are defined at firstChunkAt/lastModelChunkAt above.
      const firstTokenMs = firstChunkAt.get(step);
      const lastTokenMs = lastModelChunkAt.get(step) ?? firstTokenMs;
      const ttftMs =
        firstTokenMs !== undefined
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
      const windowMs = (
        window: StreamWindow | undefined,
      ): number | undefined =>
        window ? Math.max(0, window.last - window.first) : undefined;
      const reasoningMs = windowMs(reasoningWindow.get(step));
      const textMs = windowMs(textWindow.get(step));
      const toolInputMs = windowMs(toolInputWindow.get(step));
      const stepAttemptAttributes = attemptAttributes(
        step,
        stepStartMs,
        serialize,
      );
      stepStartedAt.delete(step);
      firstChunkAt.delete(step);
      lastModelChunkAt.delete(step);
      reasoningWindow.delete(step);
      textWindow.delete(step);
      toolInputWindow.delete(step);
      stepAttempts.delete(step);

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
      stepStartedAt.clear();
      firstChunkAt.clear();
      lastModelChunkAt.clear();
      reasoningWindow.clear();
      textWindow.clear();
      toolInputWindow.clear();
      stepAttempts.clear();
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
   * here. `cacheWriteTokens` is the step's metered count, which may come from
   * providerMetadata when the usage shape lacks it.
   */
  addStep: (
    stepNumber: number,
    usage: LanguageModelUsage | undefined,
    cacheWriteTokens: number,
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
    addStep: (stepNumber, stepUsage, stepCacheWriteTokens) => {
      cacheWriteTokens += stepCacheWriteTokens;
      const soFar = usageTokenTotals(usage);
      const stepTokens = usageTokenTotals(stepUsage);
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
