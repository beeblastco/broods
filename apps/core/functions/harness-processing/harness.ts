/**
 * Agent-side harness core.
 * Keep turn context assembly, model invocation, and tools orchestration here.
 */

import {
  stepCountIs,
  streamText,
  type AssistantModelMessage,
  type JSONValue,
  type ModelMessage,
  type StepResult,
  type ToolCallPart,
  type ToolApprovalRequestOutput,
  type ToolSet,
} from "ai";
import {
  context as otelContextApi,
  SpanStatusCode,
  trace as otelTraceApi,
  type Context as OtelContext,
  type Span,
} from "@opentelemetry/api";
import type { AgentConfig } from "../_shared/storage/index.ts";
import { collectSecretValues, logError, logInfo, redact, redactSensitiveText } from "../_shared/log.ts";
import { recordUsageTask } from "../_shared/telemetry.ts";
import { extractCacheWriteTokens } from "./usage-metering.ts";
import {
  getTracer,
  forceFlushOtel,
  mintTraceId,
  mintSpanId,
  observabilityAttributes,
  setObservabilityContext,
  getObservabilityContext,
} from "../_shared/otel.ts";
import type { ObservabilitySpanRow } from "../../../../packages/filthy-panty/src/observability-contracts.ts";
import { tracesSubject, getObservabilityNatsConn } from "../_shared/nats.ts";
import {
  modelOutputFromModelConfig,
  modelSettingsFromModelConfig,
  providerOptionsFromModelConfig,
  resolveConfiguredModel,
} from "./provider.ts";
import { stripReasoningFromMessages } from "./pruning.ts";
import type { Session, TurnContextSnapshot } from "./session.ts";
import type { RunAsyncToolDispatch } from "./async-tools.ts";
import { createAgentLifecycleEmitter, toLifecycleValue } from "./lifecycle.ts";
import { createTools } from "./tools/index.ts";
import type { SandboxCpuSample } from "./sandbox/types.ts";
import type { RunSubagentDispatch } from "./tools/run-subagent.tool.ts";

// Default max agent iterations to prevent looping or too long execution.
const MAX_AGENT_ITERATIONS = 30;
const MAX_TRACE_ATTRIBUTE_CHARS = 12_000;

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

/** Publish a span update to the live traces subject. Best-effort, non-blocking. */
function publishSpan(row: ObservabilitySpanRow): void {
  const connPromise = getObservabilityNatsConn();
  if (!connPromise) return;

  const ctx = getObservabilityContext();
  // Skip traffic that cannot be resolved to a deployment. No dashboard trace
  // subscription exists for that scope; Tempo still receives the OTel span.
  if (!ctx || !ctx.endpointId || !ctx.project || !ctx.environment) return;

  const subject = tracesSubject(ctx.accountId, ctx.project, ctx.environment, ctx.endpointId);
  connPromise
    .then((conn) => {
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

// Optional per-run wiring owned by the request handler.
export interface AgentLoopOptions {
  dispatchSubagents?: RunSubagentDispatch;
  dispatchAsyncTools?: RunAsyncToolDispatch;
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

  // Task-scoped usage accumulators — written by hooks/callbacks, read at finalize.
  let taskCacheWriteTokens = 0;
  // Accumulate sandbox CPU per (type, role, tool); each bucket becomes one
  // sandboxUsage row at finalize. CPU only arrives for kubernetes execs.
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
  const tracer = getTracer();
  const otelRootSpan = tracer.startSpan("agent.task", {
    startTime: runStartedAt,
    attributes: observabilityAttributes(observabilityScope),
  });
  const otelSpanCtx = otelRootSpan.spanContext();
  const traceId = /[^0]/.test(otelSpanCtx.traceId) ? otelSpanCtx.traceId : mintTraceId();
  const rootSpanId = /[^0]/.test(otelSpanCtx.spanId) ? otelSpanCtx.spanId : mintSpanId();
  const rootOtelContext = otelTraceApi.setSpan(otelContextApi.active(), otelRootSpan);
  const parentObservabilityContext = getObservabilityContext();
  setObservabilityContext({
    ...observabilityScope,
    traceId,
    otelContext: rootOtelContext,
    secretValues: collectSecretValues([agentConfig, statelessSandbox, resolvedWorkspaces]),
  });

  const traceAttribute = (value: unknown): string => {
    const safeValue = redact(value, getObservabilityContext()?.secretValues ?? []);
    let serialized: string;
    try {
      serialized = safeValue === undefined
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
  };
  otelRootSpan.setAttributes(rootRunningAttributes);
  publishSpan({
    traceId,
    spanId: rootSpanId,
    name: "agent.task",
    kind: "task",
    startTimeMs: runStartedAt,
    endTimeMs: runStartedAt,
    durationMs: 0,
    status: "running",
    endpointId: session.endpointId,
    agentId: session.agentId,
    conversationKey: session.conversationKey,
    attributes: rootRunningAttributes,
  });

  const tools = {
    ...await createTools({
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
      // The handler owns subagent lifecycle, so the loop only forwards the
      // dispatcher into the tool registry for this one model run. Ephemeral
      // system messages are request-local, so pass the current turn copy into
      // child dispatch instead of expecting the coordinator to reload it.
      ...(options.dispatchSubagents
        ? {
          dispatchSubagents: (tasks, messages) =>
            options.dispatchSubagents!(tasks, stripReasoningFromMessages(messages), turnContext.ephemeralSystem),
        }
        : {}),
    }, agentConfig),
  } satisfies ToolSet;
  const enabledTools = Object.keys(tools).length > 0 ? tools : undefined;
  const modelSettings = modelSettingsFromModelConfig(agentConfig);
  const modelOutput = modelOutputFromModelConfig(agentConfig);
  const providerOptions = providerOptionsFromModelConfig(agentConfig);
  let approvalSummaries: ToolApprovalSummary[] = [];
  let finalResponse: JSONValue | undefined;

  // Child OTel spans remain open until the corresponding AI SDK finish hook.
  // Their real OTel IDs are reused in the live NATS trace rows.
  const stepSpans = new Map<number, TrackedSpan>();
  const toolSpans = new Map<string, TrackedSpan>();
  const startTrackedSpan = (
    name: "model.step" | "tool.call",
    startTimeMs: number,
    parentContext: OtelContext,
    parentSpanId: string,
    attributes: Record<string, string | number | boolean>,
  ): TrackedSpan => {
    const otelSpan = tracer.startSpan(name, {
      startTime: startTimeMs,
      attributes: {
        ...observabilityAttributes(observabilityScope),
        ...attributes,
      },
    }, parentContext);
    const spanContext = otelSpan.spanContext();

    return {
      otelSpan,
      otelContext: otelTraceApi.setSpan(parentContext, otelSpan),
      name,
      traceId: /[^0]/.test(spanContext.traceId) ? spanContext.traceId : traceId,
      spanId: /[^0]/.test(spanContext.spanId) ? spanContext.spanId : mintSpanId(),
      parentSpanId,
      startTimeMs,
      attributes,
    };
  };

  // Log context
  const stepStartedAt = new Map<number, number>();
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
  // records retain tenant/trace context, then explicitly flushes before Lambda can
  // freeze the process.
  let usageFinalized = false;
  let finishObserved = false;
  let taskUsage: unknown;
  let taskStepCount = 0;
  let terminalError: Error | undefined;
  const finalizeUsage = async (
    status: "completed" | "failed",
    usage: unknown,
    stepCount: number,
    toolCallCount: number,
    durationMs: number,
    error?: Error,
  ): Promise<void> => {
    if (usageFinalized) return;
    usageFinalized = true;

    const context = getObservabilityContext();
    const sanitizedError = error
      ? new Error(redactSensitiveText(error.message, context?.secretValues))
      : undefined;

    // Close the root OTel span. Published live via NATS and exported durably
    // via the OTLP exporter registered in otel.ts.
    const endTimeMs = runStartedAt + durationMs;
    for (const tracked of [...toolSpans.values(), ...stepSpans.values()]) {
      if (status === "failed") {
        tracked.otelSpan.setStatus({ code: SpanStatusCode.ERROR, message: sanitizedError?.message });
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
    const rootSpanRow: ObservabilitySpanRow = {
      traceId,
      spanId: rootSpanId,
      name: "agent.task",
      kind: "task",
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
      },
      ...(sanitizedError ? { error: sanitizedError.message } : {}),
    };

    // End the root OTel span (durable Tempo export).
    try {
      otelRootSpan.setAttributes(
        rootSpanRow.attributes as Record<string, string | number | boolean | undefined>,
      );
      if (status === "failed") {
        if (sanitizedError) otelRootSpan.recordException(sanitizedError);
        otelRootSpan.setStatus({ code: SpanStatusCode.ERROR, message: sanitizedError?.message });
      } else {
        otelRootSpan.setStatus({ code: SpanStatusCode.OK });
      }
      otelRootSpan.end(endTimeMs);
    } catch {
      // Best-effort: never fail the agent path.
    }

    // Live publish via NATS.
    publishSpan(rootSpanRow);

    const u = (usage ?? {}) as Record<string, number | undefined>;
    try {
      await recordUsageTask({
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
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        reasoningTokens: u.reasoningTokens ?? 0,
        cachedInputTokens: u.cachedInputTokens ?? 0,
        cacheWriteTokens: taskCacheWriteTokens,
        totalTokens: u.totalTokens ?? 0,
        runtimeKind: "lambda",
        runtimeWallMs: durationMs,
        runtimeMemoryMb: parseInt(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE ?? "0", 10),
        sandboxUsage: [...sandboxUsageByKey.values()],
        stepCount,
        toolCallCount,
      });
      await forceFlushOtel();
    } finally {
      // Lambda execution environments are reused, so never retain one task's
      // tenant, trace, or secret values after its exporters have flushed.
      setObservabilityContext(parentObservabilityContext);
    }
  };

  await lifecycle.emit("agent.started", {
    modelProvider: configuredModel.providerName,
    modelId: agentConfig.model?.modelId,
    messageCount: turnContext.messages.length,
  });

  logInfo("Agent loop started", {
    eventType: "model.invocation.started",
    ...logContext,
    messageCount: turnContext.messages.length,
    enabledTools: Object.keys(tools),
  });

  const stream = streamText({
    maxOutputTokens: 16000,
    ...modelSettings,
    model: configuredModel.model,
    system: turnContext.system,
    messages: turnContext.messages,
    ...(modelOutput ? { output: modelOutput } : {}),
    ...(enabledTools ? { tools: enabledTools } : {}),
    ...(providerOptions ? { providerOptions: providerOptions as never } : {}),
    stopWhen: stepCountIs(agentConfig.agent?.maxTurn ?? MAX_AGENT_ITERATIONS),
    prepareStep: async () => {
      // `systemContextSnapshot` is the persisted system-message snapshot from
      // session.ts. Refresh it before each step so dynamic system context added
      // during a tool loop is included without replaying the full conversation.
      const refreshed = await session.loadRefreshedSystemPromptParts({
        systemContextSnapshot: systemContextSnapshot,
        ephemeralSystem: turnContext.ephemeralSystem,
      });
      systemContextSnapshot = refreshed.systemContextSnapshot;

      return {
        system: refreshed.system,
      };
    },
    experimental_onStepStart: async ({ stepNumber, messages }) => {
      const now = Date.now();
      stepStartedAt.set(stepNumber, now);
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
    experimental_onToolCallStart: async ({ stepNumber, toolCall }) => {
      const now = Date.now();
      if (stepNumber !== undefined && !stepStartedAt.has(stepNumber)) {
        stepStartedAt.set(stepNumber, now);
      }
      const parent = stepNumber !== undefined ? stepSpans.get(stepNumber) : undefined;
      const attributes = {
        "tool.name": toolCall.toolName,
        "tool.call_id": toolCall.toolCallId,
        "tool.state": "running",
        "tool.input": traceAttribute(toolCall.input),
        ...(stepNumber !== undefined ? { "agent.step_number": stepNumber } : {}),
      };
      const tracked = startTrackedSpan(
        "tool.call",
        now,
        parent?.otelContext ?? rootOtelContext,
        parent?.spanId ?? rootSpanId,
        attributes,
      );
      toolSpans.set(toolCall.toolCallId, tracked);
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
    experimental_onToolCallFinish: async ({ stepNumber, toolCall, durationMs, success, output, error }) => {
      // Close the tool.call span.
      const toolEndMs = Date.now();
      const tracked = toolSpans.get(toolCall.toolCallId) ?? startTrackedSpan(
        "tool.call",
        toolEndMs - (durationMs ?? 0),
        rootOtelContext,
        rootSpanId,
        { "tool.name": toolCall.toolName, "tool.call_id": toolCall.toolCallId },
      );
      const toolDurationMs = toolEndMs - tracked.startTimeMs;
      const errorText = success ? undefined : redactSensitiveText(
        errorMessage(error),
        getObservabilityContext()?.secretValues,
      );
      tracked.otelSpan.setAttributes({
        "tool.duration_ms": toolDurationMs,
        "tool.success": success,
        "tool.state": success ? "completed" : "failed",
        "tool.input": traceAttribute(toolCall.input),
        ...(success ? { "tool.output": traceAttribute(output) } : {}),
      });
      if (success) {
        tracked.otelSpan.setStatus({ code: SpanStatusCode.OK });
      } else {
        const spanError = new Error(errorText);
        tracked.otelSpan.recordException(spanError);
        tracked.otelSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorText });
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
        status: success ? "ok" : "error",
        endpointId: session.endpointId,
        agentId: session.agentId,
        conversationKey: session.conversationKey,
        attributes: {
          "tool.name": toolCall.toolName,
          "tool.call_id": toolCall.toolCallId,
          "tool.state": success ? "completed" : "failed",
          "tool.input": traceAttribute(toolCall.input),
          ...(success ? { "tool.output": traceAttribute(output) } : {}),
          ...(stepNumber !== undefined ? { "agent.step_number": stepNumber } : {}),
        },
        ...(errorText ? { error: errorText } : {}),
      };
      publishSpan(toolSpanRow);
      toolSpans.delete(toolCall.toolCallId);

      recordToolCallSummary(toolCallSummaries, toolCall, { stepNumber, durationMs, success });
      await lifecycle.emit("tool.call.finished", {
        stepNumber: stepNumber,
        toolCall: toLifecycleValue(toolCall),
        durationMs: durationMs,
        success: success,
        ...(success ? {} : { error: errorMessage(error) }),
      });
      const details = {
        eventType: success ? "tool.call.finished" : "tool.call.failed",
        ...logContext,
        stepNumber: stepNumber,
        toolName: toolCall.toolName,
        toolCallId: toolCall.toolCallId,
        durationMs: durationMs,
      };

      if (success) {
        logInfo("Tool call finished", details);
        return;
      }

      logError("Tool call failed", {
        ...details,
        error: errorMessage(error),
        errorDetails: serializeError(error),
      });
    },
    onStepFinish: async ({
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
      const durationMs = startedAt === undefined ? undefined : Date.now() - startedAt;
      stepStartedAt.delete(stepNumber);
      for (const toolCall of toolCalls) {
        recordToolCallSummary(toolCallSummaries, toolCall, { stepNumber });
      }

      // providerMetadata is typed as ProviderMetadata (Record<string, Record<string, unknown>>)
      // by the AI SDK; cast to the shape extractCacheWriteTokens expects.
      const meta = providerMetadata as Record<string, unknown> | undefined;
      taskCacheWriteTokens += extractCacheWriteTokens(configuredModel.providerName, meta);

      await lifecycle.emit("agent.step.finished", {
        stepNumber: stepNumber,
        finishReason: finishReason,
        usage: toLifecycleValue(usage),
        toolCallCount: toolCalls.length,
        toolResultCount: toolResults.length,
        warningCount: warnings?.length ?? 0,
      });
      await Promise.all(toolResults.map((toolResult) =>
        lifecycle.emit("tool.result", {
          stepNumber: stepNumber,
          toolResult: toLifecycleValue(toolResult),
        })
      ));
      logInfo("Agent loop step finished", {
        eventType: "model.step.finished",
        ...logContext,
        stepNumber: stepNumber,
        finishReason: finishReason,
        rawFinishReason: rawFinishReason,
        durationMs: durationMs,
        toolCallCount: toolCalls.length,
        toolCalls: toolCalls.map(({ toolCallId, toolName }) => ({ toolCallId, toolName })),
        usage: usage,
        responseMetadata: {
          id: response.id,
          modelId: response.modelId,
          timestamp: response.timestamp.toISOString(),
        },
        providerMetadata,
      });

      // Publish the model.step span (tree: agent.task -> model.step -> tool.call).
      // Tool spans reference this stepSpanId as their parent; without it they
      // would be orphaned in the trace view.
      const tracked = stepSpans.get(stepNumber);
      if (tracked) {
        const stepEndMs = Date.now();
        const attributes = {
          ...tracked.attributes,
          "agent.step_number": stepNumber,
          "step.state": "completed",
          "model.finish_reason": finishReason,
          "agent.tool_call_count": toolCalls.length,
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
      stepSpans.delete(stepNumber);
    },
    onError: async ({ error }) => {
      const errorText = errorMessage(error);
      const tools = summarizeToolsUsed(toolCallSummaries);
      didFail = true;
      failureText = errorText;
      terminalError = error instanceof Error ? error : new Error(errorText);
      logError("Agent loop failed", {
        eventType: "model.invocation.failed",
        ...logContext,
        durationMs: Date.now() - runStartedAt,
        toolsUsed: tools.toolsUsed,
        toolUsage: tools.toolUsage,
        toolCalls: tools.toolCalls,
        error: errorText,
        errorDetails: serializeError(error),
      });

      await lifecycle.emit("agent.failed", {
        error: errorText,
        toolsUsed: toLifecycleValue(tools.toolsUsed),
        toolUsage: toLifecycleValue(tools.toolUsage),
        toolCalls: toLifecycleValue(tools.toolCalls),
      });
      await reply?.onErrorText(errorText).catch(() => { });
    },
    onFinish: async ({
      response,
      text,
      finishReason,
      rawFinishReason,
      steps,
      toolCalls,
      usage,
      totalUsage,
    }) => {
      for (const toolCall of toolCalls) {
        recordToolCallSummary(toolCallSummaries, toolCall, {});
      }

      const finalText = text.trim();
      const stepCount = steps.length;
      const toolCallCount = toolCalls.length;
      finishObserved = true;
      taskUsage = totalUsage ?? usage;
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
        usage: totalUsage,
      };

      try {
        await session.persistModelMessages(
          approvalRequests.length > 0
            ? withApprovalToolCalls(response.messages, approvalRequests)
            : response.messages,
        );

        if (approvals.length > 0) {
          approvalSummaries = approvals;
          logInfo("Model invocation finished", finishLog);
          await lifecycle.emit("agent.approval.required", {
            approvals: toLifecycleValue(approvals),
            toolsUsed: toLifecycleValue(tools.toolsUsed),
            toolUsage: toLifecycleValue(tools.toolUsage),
            toolCalls: toLifecycleValue(tools.toolCalls),
          });
          await reply?.onApprovalRequired?.(approvals);
          return;
        }

        if (modelOutput) {
          finalResponse = await modelOutput.parseCompleteOutput({ text }, { response, usage, finishReason }) as JSONValue;
          await reply?.onFinalText(finalResponse);
          logInfo("Model invocation finished", finishLog);
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

        if (!finalText) {
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
          logError(errorText, {
            eventType: "model.invocation.failed",
            ...logContext,
            durationMs: Date.now() - runStartedAt,
            finishReason: finishReason,
            stepCount: stepCount,
            toolCallCount: toolCallCount,
            toolsUsed: tools.toolsUsed,
            toolUsage: tools.toolUsage,
            toolCalls: tools.toolCalls,
            usage: totalUsage ?? usage,
          });
          await lifecycle.emit("agent.failed", {
            error: errorText,
            finishReason: finishReason,
            stepCount: stepCount,
            toolCallCount: toolCallCount,
            toolsUsed: toLifecycleValue(tools.toolsUsed),
            toolUsage: toLifecycleValue(tools.toolUsage),
            toolCalls: toLifecycleValue(tools.toolCalls),
          });
          await reply?.onErrorText(errorText).catch(() => { });
          return;
        }

        finalResponse = finalText;
        await reply?.onFinalText(finalText);
        logInfo("Model invocation finished", finishLog);
        await lifecycle.emit("agent.finished", {
          finishReason: finishReason,
          stepCount: stepCount,
          toolCallCount: toolCallCount,
          toolsUsed: toLifecycleValue(tools.toolsUsed),
          toolUsage: toLifecycleValue(tools.toolUsage),
          toolCalls: toLifecycleValue(tools.toolCalls),
          response: finalText,
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
        await reply?.onErrorText(errorText).catch(() => { });
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

  // Wrap consumeStream so finalizeUsage fires in a finally block even when
  // streamText throws hard (e.g. network failure before any chunk arrives) and
  // onFinish / onError never run. The idempotent flag inside finalizeUsage
  // prevents a double-write when the callbacks did run.
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
      if (!usageFinalized) {
        if (!finishObserved) {
          didFail = true;
          terminalError ??= new Error("Model stream ended without a completion callback");
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
      }
    }
  };

  return Object.assign(stream, {
    consumeStream: wrappedConsumeStream,
    didFail: () => didFail,
    failureText: () => failureText,
    approvalSummaries: () => approvalSummaries,
    hasStructuredOutput: () => Boolean(modelOutput),
    finalResponse: () => finalResponse,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractApprovalRequests(steps: Array<StepResult<ToolSet>>): ApprovalRequestOutput[] {
  return steps.flatMap((step) =>
    step.content.flatMap((part) => {
      if (part.type !== "tool-approval-request") {
        return [];
      }

      return [part];
    })
  );
}

function summarizeApprovalRequest(request: ApprovalRequestOutput): ToolApprovalSummary {
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

function toolCallIdentity(toolCall: unknown): Pick<ToolCallSummary, "toolCallId" | "toolName"> | null {
  if (!toolCall || typeof toolCall !== "object") {
    return null;
  }

  const record = toolCall as Record<string, unknown>;
  if (typeof record.toolCallId !== "string" || typeof record.toolName !== "string") {
    return null;
  }

  return {
    toolCallId: record.toolCallId,
    toolName: record.toolName,
  };
}

function summarizeToolsUsed(summaries: Map<string, ToolCallSummary>) {
  const toolCalls = [...summaries.values()].sort((left, right) =>
    (left.stepNumber ?? 0) - (right.stepNumber ?? 0) || left.toolCallId.localeCompare(right.toolCallId)
  );
  const toolUsage = toolCalls.reduce<Record<string, number>>((counts, toolCall) => {
    counts[toolCall.toolName] = (counts[toolCall.toolName] ?? 0) + 1;
    return counts;
  }, {});

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
    approvalRequests.map((request) => [request.toolCall.toolCallId, request.toolCall]),
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
      if (part.type !== "tool-approval-request" || existingToolCallIds.has(part.toolCallId)) {
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
  if (!isRecord(error)) {
    return { message: String(error) };
  }

  const details: Record<string, unknown> = {
    name: typeof error.name === "string" ? error.name : error instanceof Error ? error.name : undefined,
    message: typeof error.message === "string" ? error.message : errorMessage(error),
  };

  for (const key of ["status", "statusCode", "requestId"]) {
    if (key in error) {
      details[key] = error[key];
    }
  }
  if (error instanceof Error && error.stack) {
    details.stack = error.stack.split("\n").slice(0, 8).join("\n");
  }

  return details;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
