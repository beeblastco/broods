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
import type { LanguageModelUsage, TextStreamPart, ToolSet } from "ai";
import { isPlainObject } from "../shared/object.ts";
import type { ModelAttempt } from "./provider.ts";
import type { SandboxCpuSample } from "./sandbox/types.ts";

/**
 * Generated-content stream parts: they count toward per-step streaming windows
 * (time-to-first-token / last-token) and are the output that keeps the silent
 * model watchdog in harness.ts from firing. v7 delivers every TextStreamPart
 * to onChunk, so boundary, lifecycle, error and post-execution parts must not
 * qualify.
 */
export const MODEL_CONTENT_CHUNK_TYPES: ReadonlySet<
  TextStreamPart<ToolSet>["type"]
> = new Set<TextStreamPart<ToolSet>["type"]>([
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

/** Two token tallies added field by field, for usage spread over several calls. */
export function addUsageTokenTotals(
  a: UsageTokenTotals,
  b: UsageTokenTotals,
): UsageTokenTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/**
 * One model call's tokens as span attributes. The dashboard prices a model.step
 * and a compaction phase by these names (`stepTokens`, `isModelCallSpan`).
 */
export function modelTokenAttributes(
  tokens: UsageTokenTotals,
): Record<string, number> {
  return {
    "model.input_tokens": tokens.inputTokens,
    "model.output_tokens": tokens.outputTokens,
    "model.reasoning_tokens": tokens.reasoningTokens,
    "model.cached_input_tokens": tokens.cachedInputTokens,
    "model.cache_write_tokens": tokens.cacheWriteTokens,
    "model.total_tokens": tokens.totalTokens,
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
  /**
   * attemptRecordingMiddleware: one entry per doStream call of the active
   * step. The SDK awaits onStepStart before every doStream, so there always is
   * one; an attempt without one is dropped rather than filed on another step.
   */
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
      if (activeStepNumber !== undefined) {
        stepOf(activeStepNumber).attempts.push(attempt);
      }
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
 * finished step, onEnd may replace the sum with the turn total, an
 * auto-compaction adds its summary calls after that, finalize reads.
 */
export interface TaskTotals {
  /**
   * onStepEnd: folds a finished step in. An aborted run never reaches onEnd,
   * and a stopped one gets an empty total there, so finished steps are summed
   * here. `stepTokens` is the step's flattened usage, which the step span also
   * reads; `cacheWriteTokensFallback` is the providerMetadata count, metered
   * only when that usage lacks one. Returns the step's metered cache-write
   * tokens, which its span reports too.
   */
  addStep: (
    stepNumber: number,
    stepTokens: UsageTokenTotals,
    cacheWriteTokensFallback: number,
  ) => number;
  /**
   * Folds in an auto-compaction's summary calls after the turn ends, so the
   * run's usage row and root span count what the summary cost. Not a step.
   */
  addCompaction: (tokens: UsageTokenTotals) => void;
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
  const fold = (tokens: UsageTokenTotals): void => {
    const sum = addUsageTokenTotals(usageTokenTotals(usage), tokens);
    usage = {
      inputTokens: sum.inputTokens,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: sum.cachedInputTokens,
        cacheWriteTokens: sum.cacheWriteTokens,
      },
      outputTokens: sum.outputTokens,
      outputTokenDetails: {
        textTokens: undefined,
        reasoningTokens: sum.reasoningTokens,
      },
      totalTokens: sum.totalTokens,
    };
  };

  return {
    addStep: (stepNumber, stepTokens, cacheWriteTokensFallback) => {
      const stepCacheWriteTokens =
        stepTokens.cacheWriteTokens || cacheWriteTokensFallback;
      cacheWriteTokens += stepCacheWriteTokens;
      fold(stepTokens);
      steps = stepNumber + 1;

      return stepCacheWriteTokens;
    },
    addCompaction: (tokens) => {
      cacheWriteTokens += tokens.cacheWriteTokens;
      fold(tokens);
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

/** A window's length, or undefined when that kind never streamed. */
function windowMs(window: StreamWindow | undefined): number | undefined {
  return window ? Math.max(0, window.last - window.first) : undefined;
}
