import {
  canonicalModelProvider,
  PROVIDER_CACHE_WRITE_FIELDS,
} from "@broods/convex/model/modelPricing";
import type { LanguageModelUsage, TextStreamPart, ToolSet } from "ai";
import { isPlainObject } from "../shared/object.ts";
import type { ModelAttempt } from "./provider.ts";
import type { SandboxCpuSample } from "./sandbox/types.ts";

// v7 hands onChunk every stream part; only these are generated content, which feeds the
// streaming windows and keeps the silent-model watchdog in harness.ts quiet.
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

// The dashboard prices model.step and compaction spans by these names (`stepTokens`).
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

export function extractCacheWriteTokens(
  providerName: string | undefined,
  providerMetadata: Record<string, unknown> | undefined,
): number {
  if (!providerMetadata || !providerName) return 0;

  const provider = canonicalModelProvider(providerName);
  const field = PROVIDER_CACHE_WRITE_FIELDS[provider];
  if (!field) return 0;

  const providerBlock = providerMetadata[provider];
  if (isPlainObject(providerBlock)) {
    const val = providerBlock[field];
    if (typeof val === "number" && val > 0) return val;
  }

  // Bedrock nests the Anthropic block under bedrock.anthropic, or sets the field on bedrock.
  if (provider === "bedrock") {
    const bedrockBlock = providerMetadata["bedrock"];
    if (isPlainObject(bedrockBlock)) {
      const anthropicBlock = bedrockBlock["anthropic"];
      if (isPlainObject(anthropicBlock)) {
        const val = anthropicBlock[field];
        if (typeof val === "number" && val > 0) return val;
      }
      const direct = bedrockBlock[field];
      if (typeof direct === "number" && direct > 0) return direct;
    }
  }

  return 0;
}

export interface SandboxCpuLedger {
  record: (sample: SandboxCpuSample) => void;
  takeToolCompute: (
    toolCallId: string,
  ) => Pick<SandboxCpuSample, "type" | "cpuUsec"> | undefined;
  roleAttributes: () => Record<string, number>;
  typeAttributes: () => Record<string, number>;
  usage: () => SandboxCpuSample[];
}

export function createSandboxCpuLedger(): SandboxCpuLedger {
  const sandboxUsageByKey = new Map<string, SandboxCpuSample>();
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

interface StreamWindow {
  first: number;
  last: number;
}

interface StepTiming {
  startedAt: number | undefined;
  // onChunk has no step number, so chunks go to the active step.
  firstChunkAt: number | undefined;
  lastChunkAt: number | undefined;
  reasoning: StreamWindow | undefined;
  text: StreamWindow | undefined;
  toolInput: StreamWindow | undefined;
  // The SDK retries a failed stream start silently; attemptRecordingMiddleware records each try.
  attempts: ModelAttempt[];
}

export interface StepTimingTracker {
  startStep: (step: number, nowMs: number) => void;
  activeStep: () => number | undefined;
  endActiveStep: (step: number) => void;
  stepStartMs: (step: number) => number | undefined;
  recordChunk: (
    chunkType: TextStreamPart<ToolSet>["type"],
    nowMs: number,
  ) => void;
  // The SDK awaits onStepStart before each doStream; an attempt with no step is dropped.
  recordAttempt: (attempt: ModelAttempt) => void;
  attemptAttributes: (step: number) => Record<string, string | number>;
  closeStep: (
    step: number,
    stepEndMs: number,
  ) => Record<string, string | number>;
  clear: () => void;
}

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

export interface TaskTotals {
  // onEnd never runs for an aborted run and is empty for a stopped one, so steps sum here.
  addStep: (
    stepNumber: number,
    stepTokens: UsageTokenTotals,
    cacheWriteTokensFallback: number,
  ) => number;
  addCompaction: (tokens: UsageTokenTotals) => void;
  // The turn total wins (a harness counts calls no step reported) unless a stop left it empty.
  finish: (usage: LanguageModelUsage, stepCount: number) => void;
  steps: () => number;
  usage: () => LanguageModelUsage | undefined;
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

function windowMs(window: StreamWindow | undefined): number | undefined {
  return window ? Math.max(0, window.last - window.first) : undefined;
}
