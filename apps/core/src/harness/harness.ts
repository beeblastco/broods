/**
 * Agent-side harness core.
 * Keep turn context assembly, model invocation, and tools orchestration here.
 */

import {
  NoSuchProviderReferenceError,
  UnsupportedFunctionalityError,
} from "@ai-sdk/provider";
import {
  context as otelContextApi,
  trace as otelTraceApi,
  SpanStatusCode,
  type Context as OtelContext,
  type Span,
} from "@opentelemetry/api";
import {
  isStepCount,
  streamText,
  type AssistantModelMessage,
  type JSONValue,
  type LanguageModelUsage,
  type ModelMessage,
  type StepResult,
  type SystemModelMessage,
  type ToolApprovalRequestOutput,
  type ToolCallPart,
  type ToolSet,
} from "ai";
import type { ObservabilitySpanRow } from "../../../../packages/broods/src/observability-contracts.ts";
import { consumeColdStart } from "../shared/cold-start.ts";
import type { AgentConfig } from "../shared/domain/agent-config.ts";
import {
  collectSecretValues,
  logError,
  logInfo,
  logWarn,
  redact,
  redactSensitiveText,
} from "../shared/log.ts";
import {
  ensureObservabilityStream,
  flushObservabilityNats,
  getObservabilityNatsConn,
  tracesSubject,
} from "../shared/nats.ts";
import { isPlainObject } from "../shared/object.ts";
import {
  forceFlushOtel,
  getObservabilityContext,
  getTracer,
  mintSpanId,
  mintTraceId,
  observabilityAttributes,
  setObservabilityContext,
} from "../shared/otel.ts";
import { recordTaskUsage } from "../shared/telemetry.ts";
import type { RunAsyncToolDispatch } from "./async-tools.ts";
import {
  createAgentHookDispatcher,
  wrapToolsWithHooks,
  type HookDispatcher,
} from "./hook-dispatcher.ts";
import { createAgentLifecycleEmitter, toLifecycleValue } from "./lifecycle.ts";
import {
  createPolicyToolApproval,
  createRuntimeToolApproval,
} from "./policy.ts";
import {
  modelOutputFromModelConfig,
  modelSettingsFromModelConfig,
  providerOptionsFromModelConfig,
  resolveConfiguredModel,
} from "./provider.ts";
import { stripReasoningFromMessages } from "./pruning.ts";
import type { SandboxCpuSample } from "./sandbox/types.ts";
import {
  stripEnvelopeFieldsFromMessages,
  type ConversationIngressEvent,
  type Session,
  type TurnContextSnapshot,
} from "./session.ts";
import { createTools } from "./tools/index.ts";
import type { RunSubagentDispatch } from "./tools/run-subagent.tool.ts";
import { extractCacheWriteTokens, usageTokenTotals } from "./usage-metering.ts";

// Default max agent iterations to prevent looping or too long execution.
const MAX_AGENT_ITERATIONS = 30;
// Per-attribute cap on serialized trace payloads. Generous so reasoning / tool
// I/O show in full on the dashboard (delivered full-fidelity over the live
// JetStream path); still well under the NATS 1MB max-payload ceiling. Tempo may
// truncate further on its side, but that only affects history older than the
// JetStream replay window.
const MAX_TRACE_ATTRIBUTE_CHARS = 32_000;

const SPAN_ENCODER = new TextEncoder();

type TrackedSpan = {
  otelSpan: Span;
  otelContext: OtelContext;
  name: "model.step" | "tool.call";
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTimeMs: number;
  attributes: Record<string, string | number | boolean>;
};

/** Revalidates the fencing token immediately before any executable tool starts. */
function wrapToolsWithOwnerFence(tools: ToolSet, session: Session): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    const originalExecute = tool.execute;
    if (typeof originalExecute !== "function") {
      wrapped[name] = tool;
      continue;
    }
    wrapped[name] = {
      ...tool,
      execute: async (input: unknown, options: unknown) => {
        await session.assertCurrentOwner?.();
        return (
          originalExecute as (value: unknown, execution: unknown) => unknown
        )(input, options);
      },
    } as ToolSet[string];
  }
  return wrapped;
}

/** Publish a span update to the live traces subject. Best-effort, non-blocking. */
// Returns once the span's bytes have been handed to the NATS client; callers that
// must guarantee delivery before the container freezes (the terminal span) await
// this and then flushObservabilityNats(). Running/intermediate spans ignore it.
function publishSpan(row: ObservabilitySpanRow): Promise<void> {
  const connPromise = getObservabilityNatsConn();
  if (!connPromise) return Promise.resolve();

  const ctx = getObservabilityContext();
  // Skip traffic that cannot be resolved to a deployment. No dashboard trace
  // subscription exists for that scope; Tempo still receives the OTel span.
  if (!ctx || !ctx.endpointId || !ctx.project || !ctx.environment)
    return Promise.resolve();

  const subject = tracesSubject(
    ctx.accountId,
    ctx.project,
    ctx.environment,
    ctx.endpointId,
  );

  return connPromise
    .then(async (conn) => {
      // Ensure the durable stream exists so even the first span of a cold
      // container is captured for replay; memoized, so this is ~free after the
      // first call. If it fails the live publish still reaches subscribers.
      await ensureObservabilityStream(conn).catch(() => {});
      conn.publish(subject, SPAN_ENCODER.encode(JSON.stringify(row)));
    })
    .catch(() => {
      // Best-effort: NATS hiccup must not affect the run.
    });
}

type ApprovalRequestOutput = ToolApprovalRequestOutput<ToolSet>;
type ApprovalToolCall = ApprovalRequestOutput["toolCall"];
type ToolCallSummary = {
  toolCallId: string;
  toolName: string;
  stepNumber?: number;
  durationMs?: number;
  success?: boolean;
};

export type ToolApprovalSummary = Pick<ApprovalRequestOutput, "approvalId"> & {
  toolCallId: ApprovalToolCall["toolCallId"];
  toolName: ApprovalToolCall["toolName"];
  input: ApprovalToolCall["input"];
};

export interface AgentReplyHooks {
  onFinalText(response: JSONValue): Promise<void>;
  onErrorText(error: string): Promise<void>;
  onApprovalRequired?(approvals: ToolApprovalSummary[]): Promise<void>;
}

// Link back to the parent task for a subagent run. The subagent is its OWN
// top-level trace (so it gets a correctly scaled waterfall and streams live like
// the main agent); it records the parent's trace/task id as a "subtask" link, not
// as a nested child, since a subagent usually runs longer than the parent turn.
export interface SubagentParentContext {
  parentTraceId: string;
  parentTaskId: string;
}

// Optional per-run wiring owned by the request handler.
export interface AgentLoopOptions {
  dispatchSubagents?: RunSubagentDispatch;
  dispatchAsyncTools?: RunAsyncToolDispatch;
  // Present when this run is a subagent; nests its trace under the parent.
  subagentParent?: SubagentParentContext;
  // Request-shared hook dispatcher (one storage load + one ctx.state per
  // request); the loop builds its own when the handler does not pass one.
  hooks?: HookDispatcher;
}

export async function runAgentLoop(
  session: Session,
  turnContext: TurnContextSnapshot,
  agentConfig: AgentConfig,
  reply?: AgentReplyHooks,
  options: AgentLoopOptions = {},
) {
  let didFail = false;
  let failureText: string | null = null;
  let systemContextSnapshot = turnContext.systemContextSnapshot;
  const configuredModel = resolveConfiguredModel(agentConfig);
  const lifecycle = createAgentLifecycleEmitter(session, agentConfig);
  const hooks =
    options.hooks ??
    (await createAgentHookDispatcher(session.accountId, agentConfig));

  // Task-scoped usage accumulators — written by hooks/callbacks, read at finalize.
  let taskCacheWriteTokens = 0;
  // Accumulate sandbox CPU per (type, role, tool); each bucket becomes one
  // sandboxUsage row at finalize. CPU only arrives for sandbox/lambda execs.
  const sandboxUsageByKey = new Map<string, SandboxCpuSample>();
  const recordSandboxCpu = (sample: SandboxCpuSample): void => {
    if (!(sample.cpuUsec > 0)) return;
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
  };
  // Accumulated sandbox CPU split by role (agent's own sandbox vs uploaded tool
  // sandboxes), so the dashboard can stream the Compute chart live off the running
  // root span instead of waiting for the finalize write. Empty until a sandbox
  // exec reports CPU.
  const sandboxCpuRoleAttributes = (): Record<string, number> => {
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
  };

  // Start the durable root span (agent.task) up front so the same trace id is
  // stamped on every log line and NATS span row AND exported to Tempo — that shared
  // id links logs<->traces in Grafana. When OTel is not initialised the tracer is a
  // noop and its context is all-zero, so fall back to freshly minted ids for the
  // live/NATS path. project/environment come from the auth scope on the session's
  // endpointId; empty for non-deployment (channel/cron).
  const runStartedAt = Date.now();
  const observabilityScope = {
    accountId: session.accountId ?? "",
    project: session.projectSlug ?? "",
    environment: session.environmentSlug ?? "",
    endpointId: session.endpointId ?? "",
    agentId: session.agentId ?? "",
    conversationKey: session.conversationKey,
  };
  const resolvedWorkspaces = session.resolvedWorkspaces();
  const statelessSandbox = session.statelessSandbox();
  // A subagent run is its own top-level trace, distinguished by kind "subtask" and
  // linked to the parent via parent.trace_id/parent.task_id attributes (set below).
  // A normal run is a "task". Both are roots, so each gets its own scaled waterfall.
  const subagentParent = options.subagentParent;
  const rootSpanName = subagentParent ? "agent.subtask" : "agent.task";
  const rootSpanKind: ObservabilitySpanRow["kind"] = subagentParent
    ? "subtask"
    : "task";
  const tracer = getTracer();
  const otelRootSpan = tracer.startSpan(rootSpanName, {
    startTime: runStartedAt,
    attributes: observabilityAttributes(observabilityScope),
  });
  const otelSpanCtx = otelRootSpan.spanContext();
  const traceId = /[^0]/.test(otelSpanCtx.traceId)
    ? otelSpanCtx.traceId
    : mintTraceId();
  const rootSpanId = /[^0]/.test(otelSpanCtx.spanId)
    ? otelSpanCtx.spanId
    : mintSpanId();
  const rootOtelContext = otelTraceApi.setSpan(
    otelContextApi.active(),
    otelRootSpan,
  );
  const parentObservabilityContext = getObservabilityContext();
  setObservabilityContext({
    ...observabilityScope,
    traceId,
    otelContext: rootOtelContext,
    secretValues: collectSecretValues([
      agentConfig,
      statelessSandbox,
      resolvedWorkspaces,
    ]),
  });

  const traceAttribute = (value: unknown): string => {
    const safeValue = redact(
      value,
      getObservabilityContext()?.secretValues ?? [],
    );
    let serialized: string;
    try {
      serialized =
        safeValue === undefined
          ? ""
          : typeof safeValue === "string"
            ? safeValue
            : JSON.stringify(safeValue);
    } catch {
      serialized = String(safeValue);
    }
    if (serialized.length <= MAX_TRACE_ATTRIBUTE_CHARS) return serialized;

    return `${serialized.slice(0, MAX_TRACE_ATTRIBUTE_CHARS)}...[truncated]`;
  };

  const rootRunningAttributes = {
    "task.id": session.eventId,
    "task.state": "running",
    "task.delivery": session.delivery?.kind ?? "direct",
    "agent.message_count": turnContext.messages.length,
    "model.provider": configuredModel.providerName,
    "model.id": agentConfig.model?.modelId ?? "unknown",
    "model.input": traceAttribute(turnContext.messages),
    ...(subagentParent
      ? {
          "parent.task_id": subagentParent.parentTaskId,
          "parent.trace_id": subagentParent.parentTraceId,
        }
      : {}),
  };
  otelRootSpan.setAttributes(rootRunningAttributes);
  publishSpan({
    traceId,
    spanId: rootSpanId,
    name: rootSpanName,
    kind: rootSpanKind,
    startTimeMs: runStartedAt,
    endTimeMs: runStartedAt,
    durationMs: 0,
    status: "running",
    endpointId: session.endpointId,
    agentId: session.agentId,
    conversationKey: session.conversationKey,
    attributes: rootRunningAttributes,
  });

  // Emit a closed child phase span under the root task. Used for the timeline
  // phases that wrap the model loop (cold start, context prepare, compaction) so
  // a slow turn can be attributed to non-model work. Best-effort: telemetry must
  // never break the run, and a noop tracer/unscoped run simply emits nothing.
  const emitPhaseSpan = (
    phaseName: string,
    label: string,
    startMs: number,
    endMs: number,
  ): void => {
    try {
      const durationMs = Math.max(0, endMs - startMs);
      const attributes = {
        "phase.name": label,
        "phase.duration_ms": durationMs,
      };
      const phaseSpan = tracer.startSpan(
        phaseName,
        {
          startTime: startMs,
          attributes: {
            ...observabilityAttributes(observabilityScope),
            ...attributes,
          },
        },
        rootOtelContext,
      );
      const spanContext = phaseSpan.spanContext();
      phaseSpan.end(endMs);
      publishSpan({
        traceId: /[^0]/.test(spanContext.traceId)
          ? spanContext.traceId
          : traceId,
        spanId: /[^0]/.test(spanContext.spanId)
          ? spanContext.spanId
          : mintSpanId(),
        parentSpanId: rootSpanId,
        name: phaseName,
        kind: "phase",
        startTimeMs: startMs,
        endTimeMs: endMs,
        durationMs,
        status: "ok",
        endpointId: session.endpointId,
        agentId: session.agentId,
        conversationKey: session.conversationKey,
        attributes,
      });
    } catch {
      // Best-effort: a telemetry failure must not affect the run.
    }
  };

  // Cold start is charged to the first run in this execution environment; later
  // (warm) runs consume nothing. Context prepare and compaction come from the
  // turn context the handler assembled before this loop began.
  const coldStart = consumeColdStart(runStartedAt);
  if (coldStart) {
    emitPhaseSpan(
      "phase.cold_start",
      "Cold start",
      coldStart.startMs,
      coldStart.startMs + coldStart.durationMs,
    );
  }
  if (turnContext.timings) {
    emitPhaseSpan(
      "phase.context_prepare",
      "Context prepare",
      turnContext.timings.prepareStartedMs,
      turnContext.timings.prepareEndedMs,
    );
    if (turnContext.timings.compaction) {
      emitPhaseSpan(
        "phase.compaction",
        "Compaction",
        turnContext.timings.compaction.startedMs,
        turnContext.timings.compaction.endedMs,
      );
    }
  }

  const configuredApprovals = new Map<string, true>();
  const policyToolIdsByName = new Map<string, string>();
  const builtTools = {
    ...(await createTools(
      {
        accountId: session.accountId,
        conversationKey: session.conversationKey,
        workspaces: resolvedWorkspaces,
        statelessSandbox: statelessSandbox,
        statelessPermissionMode: session.statelessPermissionMode(),
        modelProviderName: configuredModel.providerName,
        modelProvider: configuredModel.provider,
        session: session,
        dispatchAsyncTools: options.dispatchAsyncTools,
        onSandboxCpu: recordSandboxCpu,
        approvalRequirements: configuredApprovals,
        policyToolIdsByName,
        sandboxMetadata: {
          traceId: traceId,
          taskId: session.eventId,
          ...(session.agentId ? { agentId: session.agentId } : {}),
          conversationKey: session.conversationKey,
        },
        // The handler owns subagent lifecycle, so the loop only forwards the
        // dispatcher into the tool registry for this one model run. Ephemeral
        // system messages are request-local, so pass the current turn copy into
        // child dispatch instead of expecting the coordinator to reload it.
        ...(options.dispatchSubagents
          ? {
              dispatchSubagents: (tasks, messages) =>
                options.dispatchSubagents!(
                  tasks,
                  stripReasoningFromMessages(messages),
                  turnContext.ephemeralSystem,
                ),
            }
          : {}),
      },
      agentConfig,
    )),
  } satisfies ToolSet;
  // Wrap tool execution so tool.call.started hooks can deny/edit args and
  // tool.result hooks can transform output (no-op when no such hooks exist).
  const tools = wrapToolsWithOwnerFence(
    wrapToolsWithHooks(builtTools, hooks),
    session,
  );
  const policyToolApproval = await createPolicyToolApproval(
    agentConfig,
    {
      accountId: session.accountId,
      project: session.projectSlug,
      environment: session.environmentSlug,
      endpointId: session.endpointId,
      agentId: session.agentId,
      conversationKey: session.conversationKey,
      delivery: session.delivery?.kind ?? "direct",
      channel:
        session.delivery?.kind === "channel"
          ? session.delivery.channelName
          : undefined,
    },
    resolvedWorkspaces,
    { toolIdsByName: policyToolIdsByName },
  );
  const toolApproval = createRuntimeToolApproval({
    configuredApprovals,
    workspaces: resolvedWorkspaces,
    ...(statelessSandbox ? { statelessSandbox } : {}),
    statelessPermissionMode: session.statelessPermissionMode(),
    ...(policyToolApproval ? { policyApproval: policyToolApproval } : {}),
  });
  const enabledTools = Object.keys(tools).length > 0 ? tools : undefined;
  const modelSettings = modelSettingsFromModelConfig(agentConfig);
  const modelOutput = modelOutputFromModelConfig(agentConfig);
  const providerOptions = providerOptionsFromModelConfig(agentConfig);
  let approvalSummaries: ToolApprovalSummary[] = [];
  let finalResponse: JSONValue | undefined;
  let lastStepText = "";

  // Child OTel spans remain open until the corresponding AI SDK finish hook.
  // Their real OTel IDs are reused in the live NATS trace rows.
  const stepSpans = new Map<number, TrackedSpan>();
  const toolSpans = new Map<string, TrackedSpan>();
  const toolStepNumbers = new Map<string, number | undefined>();
  const startTrackedSpan = (
    name: "model.step" | "tool.call",
    startTimeMs: number,
    parentContext: OtelContext,
    parentSpanId: string,
    attributes: Record<string, string | number | boolean>,
  ): TrackedSpan => {
    const otelSpan = tracer.startSpan(
      name,
      {
        startTime: startTimeMs,
        attributes: {
          ...observabilityAttributes(observabilityScope),
          ...attributes,
        },
      },
      parentContext,
    );
    const spanContext = otelSpan.spanContext();

    return {
      otelSpan,
      otelContext: otelTraceApi.setSpan(parentContext, otelSpan),
      name,
      traceId: /[^0]/.test(spanContext.traceId) ? spanContext.traceId : traceId,
      spanId: /[^0]/.test(spanContext.spanId)
        ? spanContext.spanId
        : mintSpanId(),
      parentSpanId,
      startTimeMs,
      attributes,
    };
  };

  // Log context
  const stepStartedAt = new Map<number, number>();
  // Time-to-first-token per step. onChunk has no step number, so the first chunk
  // after each step start is attributed to the active step. A step decomposes into
  // three non-overlapping segments that sum to its duration:
  //   ttft      = step start      -> first model chunk   (queue/prefill wait)
  //   streaming = first model chunk -> last model chunk   (pure token generation)
  //   tool wait = last model chunk  -> step finish         (tool execution; shown
  //               as the child tool.call spans, so streaming must NOT include it)
  // The last model chunk is the last generation delta (text / reasoning / tool-input
  // / tool-call); the post-execution `tool-result` chunk is deliberately excluded so
  // a slow tool never inflates the streaming number and misleads optimization.
  const firstChunkAt = new Map<number, number>();
  const lastModelChunkAt = new Map<number, number>();
  // Per-part streaming windows (first/last delta per kind) so the dashboard can show
  // how long the model spent streaming reasoning vs text vs tool-call input. Windows
  // are first->last per kind and may overlap slightly for models that interleave.
  type StreamWindow = { first: number; last: number };
  const reasoningWindow = new Map<number, StreamWindow>();
  const textWindow = new Map<number, StreamWindow>();
  const toolInputWindow = new Map<number, StreamWindow>();
  let activeStepNumber: number | undefined;
  const toolCallSummaries = new Map<string, ToolCallSummary>();
  const logContext = {
    accountId: session.accountId,
    agentId: session.agentId,
    conversationKey: session.conversationKey,
    eventId: session.eventId,
    modelProvider: configuredModel.providerName,
    modelId: agentConfig.model?.modelId,
  };

  // Finalize-once guard: usage is written exactly once per task and the root OTel
  // span is ended once. Finalization happens after terminal logs/replies so those
  // records retain tenant/trace context, then explicitly flushes before returning
  // to avoid losing buffered telemetry during shutdown or suspension.
  let usageFinalized = false;
  let finishObserved = false;
  let taskUsage: LanguageModelUsage | undefined;
  let taskStepCount = 0;
  let terminalError: Error | undefined;
  const finalizeUsage = async (
    status: "completed" | "failed",
    usage: LanguageModelUsage | undefined,
    stepCount: number,
    toolCallCount: number,
    durationMs: number,
    error?: Error,
  ): Promise<void> => {
    if (usageFinalized) return;
    usageFinalized = true;
    const taskTokens = usageTokenTotals(usage);

    const context = getObservabilityContext();
    const sanitizedError = error
      ? new Error(redactSensitiveText(error.message, context?.secretValues))
      : undefined;

    // Close the root OTel span. Published live via NATS and exported durably
    // via the OTLP exporter registered in otel.ts.
    const endTimeMs = runStartedAt + durationMs;
    for (const tracked of [...toolSpans.values(), ...stepSpans.values()]) {
      if (status === "failed") {
        tracked.otelSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: sanitizedError?.message,
        });
      }
      tracked.otelSpan.end(endTimeMs);
      publishSpan({
        traceId: tracked.traceId,
        spanId: tracked.spanId,
        parentSpanId: tracked.parentSpanId,
        name: tracked.name,
        kind: tracked.name,
        startTimeMs: tracked.startTimeMs,
        endTimeMs,
        durationMs: Math.max(0, endTimeMs - tracked.startTimeMs),
        status: status === "completed" ? "ok" : "error",
        endpointId: session.endpointId,
        agentId: session.agentId,
        conversationKey: session.conversationKey,
        attributes: {
          ...tracked.attributes,
          [tracked.name === "model.step" ? "step.state" : "tool.state"]: status,
        },
        ...(sanitizedError ? { error: sanitizedError.message } : {}),
      });
    }
    toolSpans.clear();
    stepSpans.clear();
    // Task totals on the root span: token usage and sandbox CPU split per provider
    // so the dashboard reads final usage straight off the trace stream.
    const cpuUsecByType = new Map<string, number>();
    for (const sample of sandboxUsageByKey.values()) {
      cpuUsecByType.set(
        sample.type,
        (cpuUsecByType.get(sample.type) ?? 0) + sample.cpuUsec,
      );
    }
    const sandboxCpuAttributes = Object.fromEntries(
      [...cpuUsecByType.entries()].map(([type, cpuUsec]) => [
        `sandbox.cpu_usec.${type}`,
        cpuUsec,
      ]),
    );
    const rootSpanRow: ObservabilitySpanRow = {
      traceId,
      spanId: rootSpanId,
      name: rootSpanName,
      kind: rootSpanKind,
      startTimeMs: runStartedAt,
      endTimeMs,
      durationMs,
      status: status === "completed" ? "ok" : "error",
      endpointId: session.endpointId,
      agentId: session.agentId,
      conversationKey: session.conversationKey,
      attributes: {
        ...rootRunningAttributes,
        "task.state": status,
        "agent.step_count": stepCount,
        "agent.tool_call_count": toolCallCount,
        "agent.model_provider": configuredModel.providerName,
        "agent.model_id": agentConfig.model?.modelId,
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
      otelRootSpan.setAttributes(
        rootSpanRow.attributes as Record<
          string,
          string | number | boolean | undefined
        >,
      );
      if (status === "failed") {
        if (sanitizedError) otelRootSpan.recordException(sanitizedError);
        otelRootSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: sanitizedError?.message,
        });
      } else {
        otelRootSpan.setStatus({ code: SpanStatusCode.OK });
      }
      otelRootSpan.end(endTimeMs);
    } catch {
      // Best-effort: never fail the agent path.
    }

    // Live publish via NATS. Awaited below before the flush so the terminal span's
    // bytes are queued and drained to the durable stream — otherwise a fresh
    // dashboard load can keep a stale "running" copy of an already-finished task.
    const rootPublished = publishSpan(rootSpanRow);

    try {
      await recordTaskUsage({
        accountId: session.accountId ?? "",
        endpointId: session.endpointId,
        agentId: session.agentId ?? "unknown",
        conversationKey: session.conversationKey,
        taskId: session.eventId,
        modelProvider: configuredModel.providerName ?? "unknown",
        modelId: agentConfig.model?.modelId ?? "unknown",
        finishedAt: endTimeMs,
        durationMs,
        status,
        inputTokens: taskTokens.inputTokens,
        outputTokens: taskTokens.outputTokens,
        reasoningTokens: taskTokens.reasoningTokens,
        cachedInputTokens: taskTokens.cachedInputTokens,
        cacheWriteTokens: taskCacheWriteTokens,
        totalTokens: taskTokens.totalTokens,
        runtimeKind: "lambda",
        runtimeWallMs: durationMs,
        runtimeMemoryMb: parseInt(
          process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE ?? "0",
          10,
        ),
        sandboxUsage: [...sandboxUsageByKey.values()],
        stepCount,
        toolCallCount,
      });
      // Ensure the terminal span's publish has been issued, then flush the OTLP
      // exporters (Tempo/Loki) AND the live NATS connection so the durable
      // OBSERVABILITY stream captures every span/log before the container freezes —
      // otherwise a publish still in flight at return is lost.
      await rootPublished;
      await Promise.allSettled([forceFlushOtel(), flushObservabilityNats()]);
    } finally {
      // The container process is reused, so never retain one task's tenant,
      // trace, or secret values after its exporters have flushed.
      setObservabilityContext(parentObservabilityContext);
    }
  };

  await lifecycle.emit("agent.started", {
    modelProvider: configuredModel.providerName,
    modelId: agentConfig.model?.modelId,
    messageCount: turnContext.messages.length,
  });
  // A user agent.started hook may inject system instructions or replace the
  // message list before the model runs. Fold its result into the turn context.
  if (hooks.hasHooksFor("agent.started")) {
    const mutation = await hooks.runMutation("agent.started", {
      system: turnContext.system.map((message) => message.content).join("\n\n"),
      messages: toLifecycleValue(turnContext.messages),
    });
    applyAgentStartedMutation(turnContext, mutation);
  }

  logInfo(
    `Agent loop started: ${configuredModel.providerName}/${agentConfig.model?.modelId ?? "unknown"} with ${turnContext.messages.length} message(s), ${Object.keys(tools).length} tool(s)`,
    {
      eventType: "model.invocation.started",
      ...logContext,
      messageCount: turnContext.messages.length,
      enabledTools: Object.keys(tools),
    },
  );

  const stream = streamText({
    maxOutputTokens: 16000,
    ...modelSettings,
    model: configuredModel.model,
    instructions: turnContext.system,
    // History messages carry envelope fields (metadata/createdAt) for hook
    // payloads; the model must see clean AI SDK shapes.
    messages: stripEnvelopeFieldsFromMessages(turnContext.messages),
    ...(modelOutput ? { output: modelOutput } : {}),
    ...(enabledTools ? { tools: enabledTools } : {}),
    ...(toolApproval ? { toolApproval } : {}),
    ...(providerOptions ? { providerOptions: providerOptions as never } : {}),
    // SDK-native OTel spans (via the @ai-sdk/otel integration registered in
    // initOtel). Inputs/outputs are off: the harness's own span rows already
    // carry redacted response/tool payloads for the dashboard.
    telemetry: {
      functionId: "harness.agent",
      recordInputs: false,
      recordOutputs: false,
    },
    stopWhen: isStepCount(agentConfig.agent?.maxTurn ?? MAX_AGENT_ITERATIONS),
    prepareStep: async ({ messages }) => {
      const renewal = await session.renewConversationLease();
      if (renewal === "stopped") {
        throw new Error("Stopped by user at the model boundary");
      }
      if (renewal === "stale") {
        throw new Error(
          "Conversation ownership changed before the next model step",
        );
      }
      const steering = await session.applySteeringIngress();
      let stepMessages = messages;
      if (steering) {
        const steeringEvents = steering.events as ConversationIngressEvent[];
        const steeringSystem =
          await session.appendIngressEvents(steeringEvents);
        turnContext.ephemeralSystem.push(...steeringSystem);
        stepMessages = [
          ...messages,
          ...stripEnvelopeFieldsFromMessages(
            steeringEvents.filter(
              (
                event,
              ): event is Exclude<
                ConversationIngressEvent,
                SystemModelMessage
              > => event.role !== "system",
            ),
          ),
        ];
        logInfo("Steering ingress applied at AI SDK step boundary", {
          eventId: session.eventId,
          conversationKey: session.conversationKey,
          steeringEventCount: steering.contributingEventIds.length,
          appliedMode: steering.appliedMode,
        });
      }
      // `systemContextSnapshot` is the persisted system-message snapshot from
      // session.ts. Refresh it before each step so dynamic system context added
      // during a tool loop is included without replaying the full conversation.
      const refreshed = await session.loadRefreshedSystemPromptParts({
        systemContextSnapshot: systemContextSnapshot,
        ephemeralSystem: turnContext.ephemeralSystem,
      });
      systemContextSnapshot = refreshed.systemContextSnapshot;

      return {
        instructions: refreshed.system,
        ...(steering ? { messages: stepMessages } : {}),
      };
    },
    onChunk: ({ chunk }) => {
      // First generated chunk of the active step marks the model's time-to-first-token.
      // Synchronous and cheap; onChunk pauses the stream until it returns.
      // v7 routes EVERY stream part through onChunk — including boundary and
      // lifecycle parts (start-step, finish-step, finish, …) and post-execution
      // tool results — so gate on generated-content parts only; anything else
      // would skew the time-to-first/last-token windows.
      if (!MODEL_CONTENT_CHUNK_TYPES.has(chunk.type)) return;
      const step = activeStepNumber;
      if (step === undefined) return;
      const now = Date.now();
      if (!firstChunkAt.has(step)) firstChunkAt.set(step, now);
      lastModelChunkAt.set(step, now);
      const bump = (windows: Map<number, StreamWindow>) => {
        const existing = windows.get(step);
        if (existing) existing.last = now;
        else windows.set(step, { first: now, last: now });
      };
      if (chunk.type === "text-delta") {
        bump(textWindow);
      } else if (chunk.type === "reasoning-delta") {
        bump(reasoningWindow);
      } else if (
        chunk.type === "tool-input-start" ||
        chunk.type === "tool-input-delta" ||
        chunk.type === "tool-call"
      ) {
        bump(toolInputWindow);
      }
    },
    onStepStart: async ({ stepNumber, messages }) => {
      const now = Date.now();
      stepStartedAt.set(stepNumber, now);
      activeStepNumber = stepNumber;
      const attributes = {
        "agent.step_number": stepNumber,
        "step.state": "running",
        "model.input": traceAttribute(messages),
      };
      const tracked = startTrackedSpan(
        "model.step",
        now,
        rootOtelContext,
        rootSpanId,
        attributes,
      );
      stepSpans.set(stepNumber, tracked);
      publishSpan({
        traceId: tracked.traceId,
        spanId: tracked.spanId,
        parentSpanId: tracked.parentSpanId,
        name: "model.step",
        kind: "model.step",
        startTimeMs: now,
        endTimeMs: now,
        durationMs: 0,
        status: "running",
        endpointId: session.endpointId,
        agentId: session.agentId,
        conversationKey: session.conversationKey,
        attributes,
      });
    },
    onToolExecutionStart: async ({ toolCall }) => {
      const stepNumber = activeStepNumber;
      const now = Date.now();
      if (stepNumber !== undefined && !stepStartedAt.has(stepNumber)) {
        stepStartedAt.set(stepNumber, now);
      }
      const parent =
        stepNumber !== undefined ? stepSpans.get(stepNumber) : undefined;
      const attributes = {
        "tool.name": toolCall.toolName,
        "tool.call_id": toolCall.toolCallId,
        "tool.state": "running",
        "tool.input": traceAttribute(toolCall.input),
        ...(stepNumber !== undefined
          ? { "agent.step_number": stepNumber }
          : {}),
      };
      const tracked = startTrackedSpan(
        "tool.call",
        now,
        parent?.otelContext ?? rootOtelContext,
        parent?.spanId ?? rootSpanId,
        attributes,
      );
      toolSpans.set(toolCall.toolCallId, tracked);
      toolStepNumbers.set(toolCall.toolCallId, stepNumber);
      publishSpan({
        traceId: tracked.traceId,
        spanId: tracked.spanId,
        parentSpanId: tracked.parentSpanId,
        name: "tool.call",
        kind: "tool.call",
        startTimeMs: now,
        endTimeMs: now,
        durationMs: 0,
        status: "running",
        endpointId: session.endpointId,
        agentId: session.agentId,
        conversationKey: session.conversationKey,
        attributes,
      });
      recordToolCallSummary(toolCallSummaries, toolCall, { stepNumber });
      await lifecycle.emit("tool.call.started", {
        stepNumber: stepNumber,
        toolCall: toLifecycleValue(toolCall),
      });
    },
    onToolExecutionEnd: async ({ toolCall, toolExecutionMs, toolOutput }) => {
      const stepNumber = toolStepNumbers.get(toolCall.toolCallId);
      toolStepNumbers.delete(toolCall.toolCallId);
      const durationMs = toolExecutionMs;
      const output =
        toolOutput.type === "tool-result" ? toolOutput.output : undefined;
      const error =
        toolOutput.type === "tool-error" ? toolOutput.error : undefined;
      // Close the tool.call span.
      const toolEndMs = Date.now();
      const tracked =
        toolSpans.get(toolCall.toolCallId) ??
        startTrackedSpan(
          "tool.call",
          toolEndMs - (durationMs ?? 0),
          rootOtelContext,
          rootSpanId,
          {
            "tool.name": toolCall.toolName,
            "tool.call_id": toolCall.toolCallId,
          },
        );
      const toolDurationMs = toolEndMs - tracked.startTimeMs;
      const outputErrorText = toolOutputErrorText(output);
      const toolSucceeded =
        toolOutput.type === "tool-result" && !outputErrorText;
      const errorText = toolSucceeded
        ? undefined
        : redactSensitiveText(
            outputErrorText ?? errorMessage(error),
            getObservabilityContext()?.secretValues,
          );
      tracked.otelSpan.setAttributes({
        "tool.duration_ms": toolDurationMs,
        "tool.success": toolSucceeded,
        "tool.state": toolSucceeded ? "completed" : "failed",
        "tool.input": traceAttribute(toolCall.input),
        ...(toolSucceeded ? { "tool.output": traceAttribute(output) } : {}),
      });
      if (toolSucceeded) {
        tracked.otelSpan.setStatus({ code: SpanStatusCode.OK });
      } else {
        const spanError = new Error(errorText);
        tracked.otelSpan.recordException(spanError);
        tracked.otelSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: errorText,
        });
      }
      tracked.otelSpan.end(toolEndMs);
      const toolSpanRow: ObservabilitySpanRow = {
        traceId: tracked.traceId,
        spanId: tracked.spanId,
        parentSpanId: tracked.parentSpanId,
        name: "tool.call",
        kind: "tool.call",
        startTimeMs: tracked.startTimeMs,
        endTimeMs: toolEndMs,
        durationMs: toolDurationMs,
        status: toolSucceeded ? "ok" : "error",
        endpointId: session.endpointId,
        agentId: session.agentId,
        conversationKey: session.conversationKey,
        attributes: {
          "tool.name": toolCall.toolName,
          "tool.call_id": toolCall.toolCallId,
          "tool.state": toolSucceeded ? "completed" : "failed",
          "tool.input": traceAttribute(toolCall.input),
          ...(toolSucceeded ? { "tool.output": traceAttribute(output) } : {}),
          ...(stepNumber !== undefined
            ? { "agent.step_number": stepNumber }
            : {}),
        },
        ...(errorText ? { error: errorText } : {}),
      };
      publishSpan(toolSpanRow);
      toolSpans.delete(toolCall.toolCallId);

      recordToolCallSummary(toolCallSummaries, toolCall, {
        stepNumber,
        durationMs,
        success: toolSucceeded,
      });
      await lifecycle.emit("tool.call.finished", {
        stepNumber: stepNumber,
        toolCall: toLifecycleValue(toolCall),
        durationMs: durationMs,
        success: toolSucceeded,
        ...(toolSucceeded ? {} : { error: errorText ?? errorMessage(error) }),
      });
      const details = {
        eventType: toolSucceeded ? "tool.call.finished" : "tool.call.failed",
        ...logContext,
        stepNumber: stepNumber,
        toolName: toolCall.toolName,
        toolCallId: toolCall.toolCallId,
        durationMs: durationMs,
      };

      if (toolSucceeded) {
        logInfo(
          `Tool call finished: ${toolCall.toolName} in ${formatDuration(durationMs)}`,
          details,
        );
        return;
      }

      logError(
        `Tool call failed: ${toolCall.toolName} in ${formatDuration(durationMs)}${errorText ? `: ${errorText}` : ""}`,
        {
          ...details,
          error: errorText ?? errorMessage(error),
          errorDetails: serializeError(error),
        },
      );
    },
    onStepEnd: async ({
      stepNumber,
      finishReason,
      rawFinishReason,
      usage,
      toolCalls,
      toolResults,
      warnings,
      response,
      providerMetadata,
      text,
      reasoningText,
    }) => {
      const startedAt = stepStartedAt.get(stepNumber);
      const durationMs =
        startedAt === undefined ? undefined : Date.now() - startedAt;
      stepStartedAt.delete(stepNumber);
      const stepText = (text ?? "").trim();
      if (stepText) {
        lastStepText = stepText;
      }
      for (const toolCall of toolCalls) {
        recordToolCallSummary(toolCallSummaries, toolCall, { stepNumber });
      }

      // providerMetadata is typed as ProviderMetadata (Record<string, Record<string, unknown>>)
      // by the AI SDK; cast to the shape extractCacheWriteTokens expects.
      const meta = providerMetadata as Record<string, unknown> | undefined;
      const stepTokens = usageTokenTotals(usage);
      taskCacheWriteTokens +=
        stepTokens.cacheWriteTokens ||
        extractCacheWriteTokens(configuredModel.providerName, meta);

      // Provider coercion warnings (e.g. an unsupported `reasoning` level or a
      // dropped setting) are silent in the stream; surface them in Loki.
      if (warnings && warnings.length > 0) {
        logWarn(
          `Model call warning on step ${stepNumber}: ${warnings
            .map((warning) => formatCallWarning(warning))
            .filter(Boolean)
            .join("; ")}`,
          {
            eventType: "model.step.warnings",
            ...logContext,
            stepNumber: stepNumber,
            warnings: warnings.map((warning) =>
              redactSensitiveText(
                formatCallWarning(warning),
                getObservabilityContext()?.secretValues,
              ),
            ),
          },
        );
      }

      await lifecycle.emit("agent.step.finished", {
        stepNumber: stepNumber,
        finishReason: finishReason,
        usage: toLifecycleValue(usage),
        toolCallCount: toolCalls.length,
        toolResultCount: toolResults.length,
        warningCount: warnings?.length ?? 0,
      });
      // agent.step.finished is observe-only for hooks (side effects, no mutation).
      if (hooks.hasHooksFor("agent.step.finished")) {
        await hooks.runMutation("agent.step.finished", {
          stepNumber: stepNumber,
          finishReason: finishReason,
          toolCallCount: toolCalls.length,
        });
      }
      await Promise.all(
        toolResults.map((toolResult) =>
          lifecycle.emit("tool.result", {
            stepNumber: stepNumber,
            toolResult: toLifecycleValue(toolResult),
          }),
        ),
      );
      logInfo(
        `Agent step ${stepNumber} finished: ${finishReason}, ${toolCalls.length} tool call(s), ${formatUsageSummary(usage)}, ${formatDuration(durationMs)}`,
        {
          eventType: "model.step.finished",
          ...logContext,
          stepNumber: stepNumber,
          finishReason: finishReason,
          rawFinishReason: rawFinishReason,
          durationMs: durationMs,
          toolCallCount: toolCalls.length,
          toolCalls: toolCalls.map(({ toolCallId, toolName }) => ({
            toolCallId,
            toolName,
          })),
          usage: usage,
          responseMetadata: {
            id: response.id,
            modelId: response.modelId,
            timestamp: response.timestamp.toISOString(),
          },
          providerMetadata,
        },
      );

      // Publish the model.step span (tree: agent.task -> model.step -> tool.call).
      // Tool spans reference this stepSpanId as their parent; without it they
      // would be orphaned in the trace view.
      const tracked = stepSpans.get(stepNumber);
      if (tracked) {
        const stepEndMs = Date.now();
        // Decompose the step so a slow step shows where the time went, without
        // conflating model streaming with tool execution:
        //   ttft      = step start      -> first token
        //   stream    = first token     -> last generated token (pure streaming)
        //   tool wait = last token      -> step finish (tool execution; also the
        //               child tool.call spans). Absent when no chunk was observed.
        const firstTokenMs = firstChunkAt.get(stepNumber);
        const lastTokenMs = lastModelChunkAt.get(stepNumber) ?? firstTokenMs;
        const ttftMs =
          firstTokenMs !== undefined
            ? Math.max(0, firstTokenMs - tracked.startTimeMs)
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
        const reasoningMs = windowMs(reasoningWindow.get(stepNumber));
        const textMs = windowMs(textWindow.get(stepNumber));
        const toolInputMs = windowMs(toolInputWindow.get(stepNumber));
        firstChunkAt.delete(stepNumber);
        lastModelChunkAt.delete(stepNumber);
        reasoningWindow.delete(stepNumber);
        textWindow.delete(stepNumber);
        toolInputWindow.delete(stepNumber);
        // Per-step token usage on the span so the dashboard can accumulate live
        // usage straight off the trace stream (no separate usage channel).
        const attributes = {
          ...tracked.attributes,
          "agent.step_number": stepNumber,
          "step.state": "completed",
          "model.finish_reason": finishReason,
          "agent.tool_call_count": toolCalls.length,
          ...(ttftMs !== undefined ? { "model.ttft_ms": ttftMs } : {}),
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
          "model.input_tokens": stepTokens.inputTokens,
          "model.output_tokens": stepTokens.outputTokens,
          "model.reasoning_tokens": stepTokens.reasoningTokens,
          "model.cached_input_tokens": stepTokens.cachedInputTokens,
          "model.total_tokens": stepTokens.totalTokens,
          "model.response": traceAttribute(text),
          "model.reasoning": traceAttribute(reasoningText ?? ""),
          "model.tool_calls": traceAttribute(toolCalls),
          "model.tool_results": traceAttribute(toolResults),
        };
        tracked.otelSpan.setAttributes(attributes);
        tracked.otelSpan.setStatus({ code: SpanStatusCode.OK });
        tracked.otelSpan.end(stepEndMs);
        publishSpan({
          traceId: tracked.traceId,
          spanId: tracked.spanId,
          parentSpanId: tracked.parentSpanId,
          name: "model.step",
          kind: "model.step",
          startTimeMs: tracked.startTimeMs,
          endTimeMs: stepEndMs,
          durationMs: stepEndMs - tracked.startTimeMs,
          status: "ok",
          endpointId: session.endpointId,
          agentId: session.agentId,
          conversationKey: session.conversationKey,
          attributes,
        });
      }
      // Re-publish the running root span with the sandbox CPU accumulated so far so
      // the dashboard's Compute chart streams live, not only at finalize. Skipped
      // until a sandbox exec actually reports CPU (keeps NATS traffic minimal).
      const liveRoleCpu = sandboxCpuRoleAttributes();
      if (Object.keys(liveRoleCpu).length > 0) {
        // A running span has no known end — keep end == start (like the initial
        // running publish) so a stale fresh-load copy never shows a fake duration.
        publishSpan({
          traceId,
          spanId: rootSpanId,
          name: rootSpanName,
          kind: rootSpanKind,
          startTimeMs: runStartedAt,
          endTimeMs: runStartedAt,
          durationMs: 0,
          status: "running",
          endpointId: session.endpointId,
          agentId: session.agentId,
          conversationKey: session.conversationKey,
          attributes: { ...rootRunningAttributes, ...liveRoleCpu },
        });
      }
      stepSpans.delete(stepNumber);
      firstChunkAt.delete(stepNumber);
      if (activeStepNumber === stepNumber) {
        activeStepNumber = undefined;
      }
    },
    onError: async ({ error }) => {
      const errorText = errorMessage(error);
      const tools = summarizeToolsUsed(toolCallSummaries);
      didFail = true;
      failureText = errorText;
      terminalError = error instanceof Error ? error : new Error(errorText);
      logError(
        `Agent loop failed after ${formatDuration(Date.now() - runStartedAt)}${tools.toolsUsed.length > 0 ? ` using ${tools.toolsUsed.join(", ")}` : ""}: ${errorText}`,
        {
          eventType: "model.invocation.failed",
          ...logContext,
          durationMs: Date.now() - runStartedAt,
          toolsUsed: tools.toolsUsed,
          toolUsage: tools.toolUsage,
          toolCalls: tools.toolCalls,
          error: errorText,
          errorDetails: serializeError(error),
        },
      );

      await lifecycle.emit("agent.failed", {
        error: errorText,
        toolsUsed: toLifecycleValue(tools.toolsUsed),
        toolUsage: toLifecycleValue(tools.toolUsage),
        toolCalls: toLifecycleValue(tools.toolCalls),
      });
      await reply?.onErrorText(errorText).catch(() => {});
    },
    onEnd: async ({
      response,
      text,
      finishReason,
      rawFinishReason,
      steps,
      toolCalls,
      usage,
    }) => {
      for (const toolCall of toolCalls) {
        recordToolCallSummary(toolCallSummaries, toolCall, {});
      }

      const finalText = (lastStepText || text).trim();
      const stepCount = steps.length;
      const toolCallCount = toolCalls.length;
      finishObserved = true;
      taskUsage = usage;
      taskStepCount = stepCount;
      const approvalRequests = extractApprovalRequests(steps);
      const approvals = approvalRequests.map(summarizeApprovalRequest);
      const tools = summarizeToolsUsed(toolCallSummaries);
      const finishLog = {
        eventType: "model.invocation.finished",
        ...logContext,
        rawFinishReason: rawFinishReason,
        durationMs: Date.now() - runStartedAt,
        finishReason: finishReason,
        stepCount: stepCount,
        toolCallCount: toolCallCount,
        toolsUsed: tools.toolsUsed,
        toolUsage: tools.toolUsage,
        toolCalls: tools.toolCalls,
        usage: usage,
      };

      try {
        await session.persistModelMessages(
          approvalRequests.length > 0
            ? withApprovalToolCalls(response.messages, approvalRequests)
            : response.messages,
        );

        if (approvals.length === 0 && !modelOutput && !finalText) {
          if (didFail) {
            return;
          }

          const errorText = [
            "Model returned empty response",
            `(finishReason: ${finishReason}, steps: ${stepCount}, toolCalls: ${toolCallCount})`,
          ].join(" ");
          didFail = true;
          failureText = errorText;
          terminalError = new Error(errorText);
          logError(
            `${errorText}${tools.toolsUsed.length > 0 ? `; tools used: ${tools.toolsUsed.join(", ")}` : ""}`,
            {
              eventType: "model.invocation.failed",
              ...logContext,
              durationMs: Date.now() - runStartedAt,
              finishReason: finishReason,
              stepCount: stepCount,
              toolCallCount: toolCallCount,
              toolsUsed: tools.toolsUsed,
              toolUsage: tools.toolUsage,
              toolCalls: tools.toolCalls,
              usage: usage,
            },
          );
          await lifecycle.emit("agent.failed", {
            error: errorText,
            finishReason: finishReason,
            stepCount: stepCount,
            toolCallCount: toolCallCount,
            toolsUsed: toLifecycleValue(tools.toolsUsed),
            toolUsage: toLifecycleValue(tools.toolUsage),
            toolCalls: toLifecycleValue(tools.toolCalls),
          });
          await reply?.onErrorText(errorText).catch(() => {});
          return;
        }

        // The invocation (and its token spend) is real even if structured-output
        // parsing or reply delivery below fails, so record the metric line once
        // here; a later failure adds its own model.invocation.failed line.
        logInfo(
          `Model invocation finished: ${finishReason}, ${stepCount} step(s), ${toolCallCount} tool call(s), ${tools.toolsUsed.length > 0 ? `tools ${tools.toolsUsed.join(", ")}, ` : ""}${formatUsageSummary(usage)}, ${formatDuration(finishLog.durationMs)}`,
          finishLog,
        );

        if (approvals.length > 0) {
          approvalSummaries = approvals;
          await lifecycle.emit("agent.approval.required", {
            approvals: toLifecycleValue(approvals),
            toolsUsed: toLifecycleValue(tools.toolsUsed),
            toolUsage: toLifecycleValue(tools.toolUsage),
            toolCalls: toLifecycleValue(tools.toolCalls),
          });
          // Runs so a hook can react to a pending approval (notify/log). Honoring
          // a returned { approve } to auto-resolve is a follow-up: it re-enters the
          // approval continuation flow, which stays owned by the handler.
          if (hooks.hasHooksFor("agent.approval.required")) {
            await hooks.runMutation("agent.approval.required", {
              approvals: toLifecycleValue(approvals),
            });
          }
          await reply?.onApprovalRequired?.(approvals);
          return;
        }

        if (modelOutput) {
          finalResponse = (await modelOutput.parseCompleteOutput(
            { text },
            { response, usage, finishReason },
          )) as JSONValue;
          finalResponse = await foldAgentFinished(
            hooks,
            finalResponse,
            finishReason,
          );
          await reply?.onFinalText(finalResponse);
          await lifecycle.emit("agent.finished", {
            finishReason: finishReason,
            stepCount: stepCount,
            toolCallCount: toolCallCount,
            toolsUsed: toLifecycleValue(tools.toolsUsed),
            toolUsage: toLifecycleValue(tools.toolUsage),
            toolCalls: toLifecycleValue(tools.toolCalls),
            response: toLifecycleValue(finalResponse),
          });
          return;
        }

        finalResponse = await foldAgentFinished(hooks, finalText, finishReason);
        await reply?.onFinalText(finalResponse);
        await lifecycle.emit("agent.finished", {
          finishReason: finishReason,
          stepCount: stepCount,
          toolCallCount: toolCallCount,
          toolsUsed: toLifecycleValue(tools.toolsUsed),
          toolUsage: toLifecycleValue(tools.toolUsage),
          toolCalls: toLifecycleValue(tools.toolCalls),
          response: toLifecycleValue(finalResponse),
        });
      } catch (err) {
        const errorText = errorMessage(err);
        const tools = summarizeToolsUsed(toolCallSummaries);
        didFail = true;
        failureText = errorText;
        terminalError = err instanceof Error ? err : new Error(errorText);
        logError("Post-generation steps failed", {
          eventType: "model.invocation.failed",
          ...logContext,
          durationMs: Date.now() - runStartedAt,
          toolsUsed: tools.toolsUsed,
          toolUsage: tools.toolUsage,
          toolCalls: tools.toolCalls,
          error: errorText,
          errorDetails: serializeError(err),
        });

        await lifecycle.emit("agent.failed", {
          error: errorText,
          toolsUsed: toLifecycleValue(tools.toolsUsed),
          toolUsage: toLifecycleValue(tools.toolUsage),
          toolCalls: toLifecycleValue(tools.toolCalls),
        });
        // agent.failed is observe-only for hooks (side effects, no mutation).
        if (hooks.hasHooksFor("agent.failed")) {
          await hooks.runMutation("agent.failed", { error: errorText });
        }
        await reply?.onErrorText(errorText).catch(() => {});
      } finally {
        await finalizeUsage(
          didFail ? "failed" : "completed",
          taskUsage,
          taskStepCount,
          toolCallCount,
          Date.now() - runStartedAt,
          terminalError,
        );
      }
    },
  });

  // Guarantee finalizeUsage runs even when onEnd/onError never fire. The AI SDK
  // skips onEnd when a run errors before any step completes (e.g. a usage-limit
  // error on the first model call) — only onError fires — so a caller that drains
  // the stream directly would never finalize and the task
  // span would spin "running" forever. Idempotent via usageFinalized.
  const ensureFinalized = async (): Promise<void> => {
    if (usageFinalized) return;
    if (!finishObserved) {
      didFail = true;
      terminalError ??= new Error(
        "Model stream ended without a completion callback",
      );
      failureText ??= terminalError.message;
    }
    await finalizeUsage(
      "failed",
      taskUsage,
      taskStepCount,
      toolCallSummaries.size,
      Date.now() - runStartedAt,
      terminalError,
    );
  };

  // Wrap consumeStream so finalizeUsage fires in a finally block even when
  // streamText throws hard (e.g. network failure before any chunk arrives) and
  // onEnd / onError never run.
  const originalConsumeStream = stream.consumeStream.bind(stream);
  const wrappedConsumeStream = async (): Promise<void> => {
    try {
      await originalConsumeStream();
    } catch (error) {
      didFail = true;
      const errorText = errorMessage(error);
      failureText ??= errorText;
      terminalError ??= error instanceof Error ? error : new Error(errorText);
      throw error;
    } finally {
      await ensureFinalized();
    }
  };

  return Object.assign(stream, {
    consumeStream: wrappedConsumeStream,
    // Callers that drain the stream themselves must call this in a finally to
    // guarantee finalization.
    ensureFinalized,
    didFail: () => didFail,
    failureText: () => failureText,
    approvalSummaries: () => approvalSummaries,
    hasStructuredOutput: () => Boolean(modelOutput),
    finalResponse: () => finalResponse,
    traceId: () => traceId,
  });
}

function errorMessage(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  // This text reaches the end user via reply.onErrorText, so it must pass the
  // same secret scrubbing the telemetry path applies before any sink sees it.
  const message = redactSensitiveText(
    rawMessage,
    getObservabilityContext()?.secretValues,
  );
  // Provider-managed assets (uploadFile/uploadSkill provider references) are
  // per-provider: switching config.model.provider mid-conversation invalidates
  // them. Return an actionable message instead of the bare provider error.
  if (NoSuchProviderReferenceError.isInstance(error)) {
    return (
      `${message} The conversation references a file or skill uploaded to a different ` +
      `provider's storage. Re-upload it for the "${error.provider}" provider, switch ` +
      `config.model.provider back, or attach the content as workspace (S3) files instead.`
    );
  }
  if (UnsupportedFunctionalityError.isInstance(error)) {
    return (
      `${message} The configured model provider does not support this capability; ` +
      `use a provider that does, or attach the content as workspace (S3) files instead of ` +
      `provider uploads.`
    );
  }
  return message;
}

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

function formatCallWarning(warning: {
  type: string;
  feature?: string;
  setting?: string;
  message?: string;
  details?: string;
}): string {
  const subject = warning.feature ?? warning.setting;
  const detail = warning.message ?? warning.details;
  return [warning.type, subject, detail].filter(Boolean).join(": ");
}

function formatDuration(durationMs: number | undefined): string {
  return typeof durationMs === "number"
    ? `${durationMs}ms`
    : "unknown duration";
}

function formatUsageSummary(usage: LanguageModelUsage | undefined): string {
  const totals = usageTokenTotals(usage);
  return `${totals.inputTokens} in / ${totals.outputTokens} out / ${totals.totalTokens} total token(s)`;
}

function toolOutputErrorText(output: unknown): string | undefined {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return undefined;
  }
  const maybeOutput = output as { type?: unknown; value?: unknown };
  return maybeOutput.type === "error-text" &&
    typeof maybeOutput.value === "string"
    ? maybeOutput.value
    : undefined;
}

// Fold an agent.started hook return into the turn context: `system` is appended
// as a system message (also to ephemeralSystem so it survives prepareStep
// refreshes), and `messages` replaces the conversation the model sees.
function applyAgentStartedMutation(
  turnContext: TurnContextSnapshot,
  mutation: Record<string, unknown> | undefined,
): void {
  if (!mutation) {
    return;
  }
  if (
    typeof mutation.system === "string" &&
    mutation.system.trim().length > 0
  ) {
    const message: SystemModelMessage = {
      role: "system",
      content: mutation.system,
    };
    turnContext.system = [...turnContext.system, message];
    turnContext.ephemeralSystem = [...turnContext.ephemeralSystem, message];
  }
  // Hooks are non-fatal, so a malformed messages override is dropped rather
  // than passed to streamText where it would fail the run.
  if (
    Array.isArray(mutation.messages) &&
    mutation.messages.every(isModelMessageShape)
  ) {
    turnContext.messages = mutation.messages as ModelMessage[];
  } else if (mutation.messages !== undefined) {
    logWarn(
      "Ignoring agent.started hook messages override: entries are not model messages",
    );
  }
}

function isModelMessageShape(entry: unknown): boolean {
  return (
    isPlainObject(entry) &&
    typeof entry.role === "string" &&
    ["system", "user", "assistant", "tool"].includes(entry.role) &&
    entry.content !== undefined
  );
}

// Fold an agent.finished hook's { output } into the final response. On the
// streaming (SSE) path the tokens are already sent, so this changes the
// delivered/stored final result, not the already-streamed text.
async function foldAgentFinished(
  hooks: HookDispatcher,
  response: JSONValue,
  finishReason: string,
): Promise<JSONValue> {
  if (!hooks.hasHooksFor("agent.finished")) {
    return response;
  }
  const mutation = await hooks.runMutation("agent.finished", {
    finishReason,
    response: toLifecycleValue(response),
  });
  return mutation && "output" in mutation
    ? (mutation.output as JSONValue)
    : response;
}

function extractApprovalRequests(
  steps: Array<StepResult<ToolSet>>,
): ApprovalRequestOutput[] {
  return steps.flatMap((step) =>
    step.content.flatMap((part) => {
      if (part.type !== "tool-approval-request") {
        return [];
      }

      return [part];
    }),
  );
}

function summarizeApprovalRequest(
  request: ApprovalRequestOutput,
): ToolApprovalSummary {
  return {
    approvalId: request.approvalId,
    toolCallId: request.toolCall.toolCallId,
    toolName: request.toolCall.toolName,
    input: request.toolCall.input,
  };
}

function recordToolCallSummary(
  summaries: Map<string, ToolCallSummary>,
  toolCall: unknown,
  update: Partial<Omit<ToolCallSummary, "toolCallId" | "toolName">>,
) {
  const identity = toolCallIdentity(toolCall);
  if (!identity) {
    return;
  }

  const existing = summaries.get(identity.toolCallId);
  summaries.set(identity.toolCallId, {
    ...existing,
    ...identity,
    ...update,
  });
}

function toolCallIdentity(
  toolCall: unknown,
): Pick<ToolCallSummary, "toolCallId" | "toolName"> | null {
  if (!toolCall || typeof toolCall !== "object") {
    return null;
  }

  const record = toolCall as Record<string, unknown>;
  if (
    typeof record.toolCallId !== "string" ||
    typeof record.toolName !== "string"
  ) {
    return null;
  }

  return {
    toolCallId: record.toolCallId,
    toolName: record.toolName,
  };
}

function summarizeToolsUsed(summaries: Map<string, ToolCallSummary>) {
  const toolCalls = [...summaries.values()].sort(
    (left, right) =>
      (left.stepNumber ?? 0) - (right.stepNumber ?? 0) ||
      left.toolCallId.localeCompare(right.toolCallId),
  );
  const toolUsage = toolCalls.reduce<Record<string, number>>(
    (counts, toolCall) => {
      counts[toolCall.toolName] = (counts[toolCall.toolName] ?? 0) + 1;
      return counts;
    },
    {},
  );

  return {
    toolsUsed: Object.keys(toolUsage).sort(),
    toolUsage,
    toolCalls,
  };
}

function withApprovalToolCalls(
  messages: ModelMessage[],
  approvalRequests: ApprovalRequestOutput[],
): ModelMessage[] {
  const toolCallsById = new Map(
    approvalRequests.map((request) => [
      request.toolCall.toolCallId,
      request.toolCall,
    ]),
  );

  return messages.map((message) => {
    if (message.role !== "assistant" || typeof message.content === "string") {
      return message;
    }

    const existingToolCallIds = new Set(
      message.content
        .filter((part) => part.type === "tool-call")
        .map((part) => part.toolCallId),
    );
    const content = message.content.flatMap((part) => {
      if (
        part.type !== "tool-approval-request" ||
        existingToolCallIds.has(part.toolCallId)
      ) {
        return [part];
      }

      const toolCall = toolCallsById.get(part.toolCallId);
      if (!toolCall) {
        return [part];
      }

      existingToolCallIds.add(part.toolCallId);
      return [toToolCallPart(toolCall), part];
    });

    return { ...message, content } satisfies AssistantModelMessage;
  });
}

function toToolCallPart(toolCall: ApprovalToolCall): ToolCallPart {
  return {
    type: "tool-call",
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    input: toolCall.input,
  };
}

function serializeError(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") {
    return { message: String(error) };
  }

  const errorObject = error as Record<string, unknown>;
  const details: Record<string, unknown> = {
    name:
      typeof errorObject.name === "string"
        ? errorObject.name
        : error instanceof Error
          ? error.name
          : undefined,
    message:
      typeof errorObject.message === "string"
        ? errorObject.message
        : errorMessage(error),
  };

  for (const key of ["status", "statusCode", "requestId"]) {
    if (key in errorObject) {
      details[key] = errorObject[key];
    }
  }
  if (error instanceof Error && error.stack) {
    details.stack = error.stack.split("\n").slice(0, 8).join("\n");
  }

  return details;
}
