import {
  NoSuchProviderReferenceError,
  UnsupportedFunctionalityError,
} from "@ai-sdk/provider";
import {
  context as otelContextApi,
  trace as otelTraceApi,
  SpanStatusCode,
  TraceFlags,
  type Context as OtelContext,
  type Span,
} from "@opentelemetry/api";
import {
  isStepCount,
  streamText,
  wrapLanguageModel,
  type AssistantModelMessage,
  type FilePart,
  type ImagePart,
  type JSONValue,
  type LanguageModelUsage,
  type ModelMessage,
  type StepResult,
  type SystemModelMessage,
  type TextPart,
  type TextStreamPart,
  type ToolApprovalRequestOutput,
  type ToolCallPart,
  type ToolSet,
  type TypedToolCall,
  type UserModelMessage,
} from "ai";
import { HarnessCapabilityUnsupportedError } from "@ai-sdk/harness";
import type { HarnessAgentSession } from "@ai-sdk/harness/agent";
import { extractHarnessPromptContent } from "@ai-sdk/harness/utils";
import type {
  ObservabilitySpanRow,
  TaskWaitingOn,
} from "../../../../packages/broods/src/observability-contracts.ts";
import { extractText } from "../shared/channels.ts";
import { consumeColdStart } from "../shared/cold-start.ts";
import {
  AGENT_MAX_TURN_UNLIMITED,
  type AgentConfig,
} from "../shared/domain/agent-config.ts";
import { principalChainLabel } from "../shared/domain/principal.ts";
import { positiveIntegerEnv } from "../shared/env.ts";
import { isContextLengthError, toErrorMessage } from "../shared/errors.ts";
import { unreadableMediaNote } from "../shared/media-types.ts";
import {
  collectSecretValues,
  logError,
  logInfo,
  logWarn,
  redactSerialized,
  redactSensitiveText,
} from "../shared/log.ts";
import {
  ensureObservabilityStream,
  getSharedNatsConn,
  tracesSubject,
} from "../shared/nats.ts";
import type { ProviderOptions, ToolResultOutput } from "@ai-sdk/provider-utils";
import { isPlainObject } from "@broods/convex/model/objects";
import {
  getObservabilityContext,
  getTracer,
  mintSpanId,
  mintTraceId,
  observabilityAttributes,
  runWithObservabilityScope,
  setObservabilityContext,
} from "../shared/otel.ts";
import { recordTaskUsage } from "../shared/telemetry.ts";
import type { RunAsyncToolDispatch } from "./async-tools.ts";
import type { RunSessionMessageDispatch } from "./ingress.ts";
import type { DispatchAppliedIngress } from "./integrations.ts";
import {
  applyMessageSendingHook,
  createAgentHookDispatcher,
  wrapToolsWithHooks,
  type HookDispatcher,
} from "./hook-dispatcher.ts";
import {
  createConfiguredHarnessAgent,
  harnessSteersMidTurn,
  openAiSdkHarnessSession,
  parkAiSdkHarnessSession,
} from "./ai-sdk-harness/index.ts";
// Not via the entrypoint: tests mock it whole, and this plumbing must stay real.
import { harnessTextBeforeImages } from "./ai-sdk-harness/adapters/index.ts";
import {
  MID_TURN_STEERING_UNSUPPORTED,
  prepareHarnessTurn,
  steerHarnessTurn,
  type HarnessTurn,
} from "./ai-sdk-harness/session.ts";
import {
  agentSandboxStatus,
  formatSandboxStatus,
  occupySandbox,
} from "./sandbox/live-status.ts";
import { configString } from "./sandbox/utils.ts";
import {
  CompactionError,
  type CompactionResult,
  compactionSpanAttributes,
  shouldAutoCompact,
} from "./compaction.ts";
import {
  createAgentLifecycleEmitter,
  toLifecycleValue,
  type AgentLifecycleEventPayload,
} from "./lifecycle.ts";
import type { PinnedFetchTransport } from "../shared/http.ts";
import {
  channelPolicyIdentity,
  createPolicyToolApproval,
  createRuntimeToolApproval,
} from "./policy.ts";
import {
  attemptRecordingMiddleware,
  cacheBreakpointFromProviderOptions,
  markedForCache,
  modelOutputFromModelConfig,
  modelSettingsFromModelConfig,
  providerOptionsFromModelConfig,
  resolveConfiguredModel,
  withCacheBreakpoint,
} from "./provider.ts";
import { createDeadlinePolicy } from "./deadline-policy.ts";
import { stripReasoningFromMessages } from "./pruning.ts";
import { createRunFinalizer } from "./run-finalizer.ts";
import { createRunSpanTracker, type RunSpanTracker } from "./run-spans.ts";
import {
  stripEnvelopeFieldsFromMessages,
  type ConversationIngressEvent,
  type Session,
  type TurnContextSnapshot,
} from "./session.ts";
import { rootEventId } from "./async-tool-result.ts";
import { rehydrateStoredMedia } from "./channel-media.ts";
import {
  openWorkAfterRun,
  type PendingQuestionSummary,
  type RunOpenWork,
} from "./questions.ts";
import { serializeToolCalls, wrapToolsWithOwnerFence } from "./tool-execute.ts";
import { COMPUTER_TOOL_NAME } from "./tools/computer.tool.ts";
import { createTools } from "./tools/index.ts";
import type { SandboxRunMetadata } from "../shared/sandbox-sizes.ts";
import type { RunSubagentDispatch } from "./tools/run-subagent.tool.ts";
import {
  parseToolResultOutput,
  type AskParent,
  type SubagentWatch,
} from "./tools/utils.ts";
import {
  createSandboxCpuLedger,
  createStepTimingTracker,
  createTaskTotals,
  extractCacheWriteTokens,
  MODEL_CONTENT_CHUNK_TYPES,
  modelTokenAttributes,
  usageTokenTotals,
} from "./usage-metering.ts";

const MAX_AGENT_ITERATIONS = 30;
// A slow step on a long context can take two minutes, so wind down with room for one more.
export const DEADLINE_WIND_DOWN_MS = 3 * 60 * 1000;
const WIND_DOWN_INSTRUCTION =
  "This turn is out of time. Reply now with what you have so far and say what is left; the user can ask you to continue.";
// Gemini flash may stop with no text after one of these; that turn finished, it did not fail.
const DELIVERY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "send-message",
  "send-files",
  "send-images",
  "send-reactions",
  "send-sticker",
]);
const DEFAULT_MODEL_FIRST_CHUNK_TIMEOUT_MS = 300_000;
const DEFAULT_MODEL_CHUNK_TIMEOUT_MS = 300_000;
const MODEL_CALL_BOUNDARY_PART_TYPES: ReadonlySet<string> = new Set([
  "start",
  "start-step",
  "finish-step",
  "tool-result",
  "tool-error",
  "tool-output-denied",
]);
// Callers match on these texts to treat a stop as intended, not a failure.
export const USER_STOP_MESSAGE = "Stopped by user at the model boundary";
export const PARENT_STOP_MESSAGE =
  "Stopped by the parent agent at the model boundary";
// Well under the NATS 1MB max payload.
const MAX_TRACE_ATTRIBUTE_CHARS = 32_000;
const MAX_TASK_INPUT_CHARS = 500;

const SPAN_ENCODER = new TextEncoder();

type ApprovalRequestOutput = ToolApprovalRequestOutput<ToolSet>;
type ApprovalToolCall = ApprovalRequestOutput["toolCall"];
type ToolCallSummary = {
  toolCallId: string;
  toolName: string;
  stepNumber?: number;
  durationMs?: number;
  success?: boolean;
};

type CompactionOutcome = { result: CompactionResult } | { error: Error };

interface RunRoot {
  span: Span;
  traceId: string;
  spanId: string;
  otelContext: OtelContext;
  spans: RunSpanTracker;
}

export type ToolApprovalSummary = Pick<ApprovalRequestOutput, "approvalId"> & {
  toolCallId: ApprovalToolCall["toolCallId"];
  toolName: ApprovalToolCall["toolName"];
  input: ApprovalToolCall["input"];
};

export interface AgentReplyHooks {
  onFinalText(response: JSONValue): Promise<void>;
  onErrorText(error: string): Promise<void>;
  onApprovalRequired?(approvals: ToolApprovalSummary[]): Promise<void>;
  onQuestionsPending?(questions: PendingQuestionSummary[]): Promise<void>;
}

// Linked, not nested: a subagent is its own trace, as it usually outlives the parent turn.
export interface SubagentParentContext {
  parentTraceId: string;
  parentTaskId: string;
}

export interface AgentLoopOptions {
  dispatchAppliedIngress?: DispatchAppliedIngress;
  dispatchSubagents?: RunSubagentDispatch;
  subagentWatch?: SubagentWatch;
  askParent?: AskParent;
  dispatchAsyncTools?: RunAsyncToolDispatch;
  dispatchSessionMessage?: RunSessionMessageDispatch;
  subagentParent?: SubagentParentContext;
  // Read on the conversation's first turn only; later turns resume on the machine it stored.
  isolatedSandbox?: boolean;
  pendingWork?: () => TaskWaitingOn | undefined;
  hooks?: HookDispatcher;
  abortSignal?: AbortSignal;
  stopMessage?: string;
  deadlineMs?: number;
  // Another slot runs the conversation on, so near the deadline stop instead of winding down.
  canYield?: boolean;
  // Test seam: webhook delivery opens its own pinned socket, not a mockable global.
  webhookTransport?: PinnedFetchTransport;
}

export type AgentLoopStream = ReturnType<typeof streamText> & {
  consumeStream(): Promise<void>;
  // drained false = the caller stopped reading mid-run, so the run is aborted before it settles.
  ensureFinalized(drained: boolean): Promise<void>;
  didFail(): boolean;
  yielded(): boolean;
  failureText(): string | null;
  approvalSummaries(): ToolApprovalSummary[];
  questionSummaries(): PendingQuestionSummary[];
  hasStructuredOutput(): boolean;
  finalResponse(): JSONValue | undefined;
  traceId(): string;
};

// A consumer that drains the stream itself after giving up passes false, so the run survives.
// `raw` parts stay here: the Claude Code harness forwards whole upstream messages as them.
export async function* readAgentFullStream(
  stream: Pick<AgentLoopStream, "stream" | "ensureFinalized">,
  abortOnEarlyExit = true,
): AsyncIterable<unknown> {
  const reader = stream.stream.getReader();
  let drained = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        drained = true;
        break;
      }
      if (value.type === "raw") continue;
      yield value;
    }
  } finally {
    if (drained || abortOnEarlyExit) {
      await reader.cancel().catch((): void => {});
      await stream.ensureFinalized(drained);
    } else {
      reader.releaseLock();
    }
  }
}

export async function runAgentLoop(
  session: Session,
  turnContext: TurnContextSnapshot,
  agentConfig: AgentConfig,
  reply?: AgentReplyHooks,
  options: AgentLoopOptions = {},
): Promise<AgentLoopStream> {
  let didFail = false;
  let failureText: string | null = null;
  const stopMessage = options.stopMessage ?? USER_STOP_MESSAGE;
  let systemContextSnapshot = turnContext.systemContextSnapshot;
  const configuredModel = resolveConfiguredModel(
    agentConfig,
    session.accountId,
  );
  const lifecycle = createAgentLifecycleEmitter(
    session,
    agentConfig,
    options.webhookTransport,
  );
  const hooks =
    options.hooks ??
    (await createAgentHookDispatcher(session.accountId, agentConfig));
  const taskTotals = createTaskTotals();
  const sandboxCpu = createSandboxCpuLedger();

  const runStartedAt = Date.now();
  const observabilityScope = sessionObservabilityScope(session);
  const resolvedWorkspaces = session.resolvedWorkspaces();
  const sandboxes = session.sandboxes();
  const subagentParent = options.subagentParent;
  const rootSpanKind: ObservabilitySpanRow["kind"] = subagentParent
    ? "subtask"
    : (session.trigger ?? "task");
  const rootSpanName = `agent.${rootSpanKind}`;
  const {
    span: otelRootSpan,
    traceId,
    spanId: rootSpanId,
    otelContext: rootOtelContext,
    spans,
  } = startRunRoot(session, rootSpanName, runStartedAt);
  const sandboxMetadata: SandboxRunMetadata = {
    traceId: traceId,
    taskId: session.eventId,
    ...(session.agentId ? { agentId: session.agentId } : {}),
    conversationKey: session.conversationKey,
  };
  let releaseSandboxOccupancy: (() => void) | undefined;
  const parentObservabilityContext = getObservabilityContext();
  setObservabilityContext({
    ...observabilityScope,
    traceId: traceId,
    otelContext: rootOtelContext,
    secretValues: collectSecretValues([
      agentConfig,
      sandboxes,
      resolvedWorkspaces,
    ]),
  });

  const traceAttribute = (value: unknown): string =>
    redactSerialized(
      value,
      getObservabilityContext()?.secretValues ?? [],
      MAX_TRACE_ATTRIBUTE_CHARS,
    );

  // A harness run reads its machine status once its session holds the machine.
  const agentMachine =
    agentConfig.harness === undefined && resolvedWorkspaces.length === 0
      ? agentSandboxStatus(sandboxes[0], session.eventId)
      : undefined;
  const agentMachineKey = configString(
    sandboxes[0]?.sandbox.options?.reservationKey,
  );
  if (agentMachine && agentMachineKey) {
    releaseSandboxOccupancy = occupySandbox(agentMachineKey, session.eventId, {
      agentId: session.agentId,
      conversationKey: session.conversationKey,
    });
  }
  const environment = session.environmentText(
    agentMachine ? formatSandboxStatus(agentMachine) : [],
  );
  const taskInput = traceAttribute(latestUserText(turnContext.messages)).slice(
    0,
    MAX_TASK_INPUT_CHARS,
  );
  const principalChain =
    session.principal && principalChainLabel(session.principal);
  let rootRunningAttributes: Record<string, string | number | boolean> = {
    "agent.environment": traceAttribute(environment),
    ...(session.principal
      ? { "principal.agentId": session.principal.agentId }
      : {}),
    ...(principalChain ? { "principal.chain": principalChain } : {}),
    "task.id": session.eventId,
    "task.state": "running",
    "task.delivery": session.delivery?.kind ?? "direct",
    "task.input": taskInput,
    "agent.message_count": turnContext.messages.length,
    "model.provider": configuredModel.providerName,
    "model.id": agentConfig.model?.modelId ?? "unknown",
    "model.input": traceAttribute(
      messagesWithoutMediaBytes(turnContext.messages),
    ),
    ...systemTraceAttributes(turnContext.system, traceAttribute),
    ...(rootEventId(session.eventId) !== session.eventId
      ? { "task.root_id": rootEventId(session.eventId) }
      : {}),
    ...(subagentParent
      ? {
          "parent.task_id": subagentParent.parentTaskId,
          "parent.trace_id": subagentParent.parentTraceId,
        }
      : {}),
  };
  otelRootSpan.setAttributes(rootRunningAttributes);
  void publishSpan({
    traceId: traceId,
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

  const coldStart = consumeColdStart(runStartedAt);
  if (coldStart) {
    spans.phase(
      "phase.cold_start",
      "Cold start",
      coldStart.startMs,
      coldStart.startMs + coldStart.durationMs,
    );
  }
  if (turnContext.timings) {
    const { phases, prepareEndedMs, prepareStartedMs } = turnContext.timings;
    spans.phase(
      "phase.context_prepare",
      "Context prepare",
      prepareStartedMs,
      prepareEndedMs,
      {
        "prepare.history_ms": phases.historyMs,
        "prepare.history_rows": phases.historyRows,
        "prepare.media_ms": phases.mediaMs,
        "prepare.memory_ms": phases.memoryMs,
        "prepare.runtime_ms": phases.runtimeMs,
        "prepare.skills_ms": phases.skillsMs,
        "prepare.subagents_ms": phases.subagentsMs,
      },
    );
    // `bun run local:verify` reads this line to hold a warm prepare to budget.
    logInfo("Context prepared", {
      eventType: "session.context.prepared",
      eventId: session.eventId,
      conversationKey: session.conversationKey,
      durationMs: prepareEndedMs - prepareStartedMs,
      ...phases,
    });
  }

  const configuredApprovals = new Map<string, true>();
  const policyMcpIdsByName = new Map<string, string>();
  const channelDelivery =
    session.delivery?.kind === "channel" ? session.delivery : undefined;
  const builtTools: ToolSet = {
    ...(await createTools(
      {
        accountId: session.accountId,
        conversationKey: session.conversationKey,
        workspaces: resolvedWorkspaces,
        sandboxes: sandboxes,
        modelProviderName: configuredModel.providerName,
        modelProvider: configuredModel.provider,
        session: session,
        dispatchAsyncTools: options.dispatchAsyncTools,
        dispatchAppliedIngress: options.dispatchAppliedIngress,
        dispatchSessionMessage: options.dispatchSessionMessage,
        onSandboxCpu: sandboxCpu.record,
        onToolRetry: spans.retry,
        onBlockingQuestion: (question): void => {
          questionSummaries.push(question);
        },
        onDetachedResult: (resultId): void => {
          detachedResultIds.push(resultId);
        },
        approvalRequirements: configuredApprovals,
        policyMcpIdsByName: policyMcpIdsByName,
        sandboxMetadata: sandboxMetadata,
        ...(channelDelivery && session.channelActions
          ? {
              channel: {
                actions: session.channelActions,
                channelName: channelDelivery.channelName,
                transformText: (text: string): Promise<string | null> =>
                  applyMessageSendingHook(
                    hooks,
                    channelDelivery.channelName,
                    text,
                  ),
              },
            }
          : {}),
        ...(options.subagentWatch
          ? { subagentWatch: options.subagentWatch }
          : {}),
        ...(options.askParent ? { askParent: options.askParent } : {}),
        // Ephemeral system messages are request-local, so children get this turn's copy.
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
  };
  // Computer actions in one step share a screen, so they run in the model's order.
  const { tools, reserve: reserveComputerTurn } = serializeToolCalls(
    wrapToolsWithOwnerFence(wrapToolsWithHooks(builtTools, hooks), session),
    COMPUTER_TOOL_NAME,
  );
  const policyToolApproval = await createPolicyToolApproval(
    agentConfig,
    {
      accountId: session.accountId,
      project: session.projectSlug,
      stage: session.stageSlug,
      endpointId: session.endpointId,
      agentId: session.agentId,
      principal: session.principal,
      conversationKey: session.conversationKey,
      delivery: session.policyDelivery?.kind ?? "direct",
      channel:
        session.policyDelivery?.kind === "channel"
          ? session.policyDelivery.channelName
          : undefined,
      ...(session.policyDelivery?.kind === "channel"
        ? channelPolicyIdentity(session.policyDelivery.identity)
        : {}),
    },
    resolvedWorkspaces,
    {
      mcpIdsByName: policyMcpIdsByName,
      sandboxes: sandboxes,
    },
  );
  const { approval: toolApproval, startStep: startApprovalStep } =
    createRuntimeToolApproval({
      configuredApprovals: configuredApprovals,
      workspaces: resolvedWorkspaces,
      sandboxes: sandboxes,
      ...(policyToolApproval ? { policyApproval: policyToolApproval } : {}),
    });
  const enabledTools = Object.keys(tools).length > 0 ? tools : undefined;
  const modelSettings = modelSettingsFromModelConfig(agentConfig);
  const modelOutput = modelOutputFromModelConfig(agentConfig);
  const providerOptions = providerOptionsFromModelConfig(
    agentConfig,
    session.conversationKey,
  );
  const cacheBreakpoint = cacheBreakpointFromProviderOptions(
    agentConfig,
    providerOptions,
  );
  let approvalSummaries: ToolApprovalSummary[] = [];
  const questionSummaries: PendingQuestionSummary[] = [];
  const detachedResultIds: string[] = [];
  let finalResponse: JSONValue | undefined;
  let lastStepText = "";

  const toolStepNumbers = new Map<string, number | undefined>();
  const stepTiming = createStepTimingTracker(traceAttribute);
  const toolCallSummaries = new Map<string, ToolCallSummary>();
  let failureAnnounced = false;
  const announceFailure = async (
    error: string,
    extra: AgentLifecycleEventPayload = {},
  ): Promise<void> => {
    if (failureAnnounced) return;
    failureAnnounced = true;
    const tools = summarizeToolsUsed(toolCallSummaries);
    await Promise.all([
      lifecycle.emit("agent.failed", {
        error: error,
        ...extra,
        toolsUsed: toLifecycleValue(tools.toolsUsed),
        toolUsage: toLifecycleValue(tools.toolUsage),
        toolCalls: toLifecycleValue(tools.toolCalls),
      }),
      hooks.hasHooksFor("agent.failed")
        ? hooks.runMutation("agent.failed", { error: error })
        : undefined,
    ]);
  };
  const logContext = {
    accountId: session.accountId,
    agentId: session.agentId,
    conversationKey: session.conversationKey,
    eventId: session.eventId,
    modelProvider: configuredModel.providerName,
    modelId: agentConfig.model?.modelId,
  };
  const usesAiSdkHarness = agentConfig.harness !== undefined;
  // A harness adapter keeps its own context, so its turns never compact the stored one.
  const autoCompact = async (
    lastInputTokens: number | undefined,
    contextExceeded = false,
  ): Promise<void> => {
    if (
      usesAiSdkHarness ||
      !shouldAutoCompact(agentConfig, lastInputTokens, contextExceeded)
    ) {
      return;
    }
    const startedMs = Date.now();
    let compacted: CompactionResult | null = null;
    try {
      compacted = await session.compactConversation("");
    } catch (err) {
      if (err instanceof CompactionError) {
        taskTotals.addCompaction(err.spent.usage);
      }
      logError("Auto-compaction failed; the turn keeps its full history", {
        ...logContext,
        error: errorMessage(err),
      });
    }
    if (compacted) {
      taskTotals.addCompaction(compacted.usage);
      spans.phase("phase.compaction", "Compaction", startedMs, Date.now(), {
        ...compactionSpanAttributes(compacted),
        "compaction.input_tokens": lastInputTokens ?? 0,
      });
    }
  };

  let finishObserved = false;
  let persistedResponseCount = 0;
  const runAbort = new AbortController();
  let terminalError: Error | undefined;
  const abortRun = (): void => {
    const reason: unknown = options.abortSignal?.reason;
    terminalError ??=
      reason instanceof Error ? reason : new Error(String(reason));
    runAbort.abort(terminalError);
  };
  if (options.abortSignal?.aborted) {
    abortRun();
  } else {
    options.abortSignal?.addEventListener("abort", abortRun, {
      once: true,
      signal: runAbort.signal,
    });
  }
  // Finalize after terminal logs and replies: they still need the tenant and trace context.
  const finalizer = createRunFinalizer({
    session: session,
    root: {
      span: otelRootSpan,
      traceId: traceId,
      spanId: rootSpanId,
      name: rootSpanName,
      kind: rootSpanKind,
      startTimeMs: runStartedAt,
    },
    rootAttributes: (): Record<string, string | number | boolean> => ({
      ...rootRunningAttributes,
      ...systemTraceAttributes(turnContext.system, traceAttribute),
    }),
    modelProvider: configuredModel.providerName,
    modelId: agentConfig.model?.modelId,
    taskInput: taskInput,
    serialize: traceAttribute,
    spans: spans,
    stepTiming: stepTiming,
    taskTotals: taskTotals,
    sandboxCpu: sandboxCpu,
    openWork: (): Promise<RunOpenWork> =>
      openWorkAfterRun({
        conversationKey: session.conversationKey,
        awaitingApproval: approvalSummaries.length > 0,
        detachedResultIds: detachedResultIds,
        questionSummaries: questionSummaries,
        pendingWork: options.pendingWork,
      }),
    publish: publishSpan,
    recordUsage: recordTaskUsage,
    release: (): void => {
      options.abortSignal?.removeEventListener("abort", abortRun);
      releaseSandboxOccupancy?.();
    },
    restoreObservabilityContext: (): void =>
      setObservabilityContext(parentObservabilityContext),
  });

  await lifecycle.emit("agent.started", {
    modelProvider: configuredModel.providerName,
    modelId: agentConfig.model?.modelId,
    messageCount: turnContext.messages.length,
  });
  if (hooks.hasHooksFor("agent.started")) {
    const mutation = await hooks.runMutation("agent.started", {
      system: turnContext.system.map((message) => message.content).join("\n\n"),
      messages: toLifecycleValue(turnContext.messages),
    });
    applyAgentStartedMutation(turnContext, mutation);
  }

  let activeHarnessSession: HarnessAgentSession | undefined;

  logInfo(
    `Agent loop started: ${configuredModel.providerName}/${agentConfig.model?.modelId ?? "unknown"} with ${turnContext.messages.length} message(s), ${Object.keys(tools).length} tool(s)`,
    {
      eventType: "model.invocation.started",
      ...logContext,
      messageCount: turnContext.messages.length,
      enabledTools: Object.keys(tools),
    },
  );

  rootRunningAttributes = {
    ...rootRunningAttributes,
    ...systemTraceAttributes(turnContext.system, traceAttribute),
    "agent.tools": traceAttribute(Object.keys(tools)),
    "agent.tool_count": Object.keys(tools).length,
  };
  otelRootSpan.setAttributes(rootRunningAttributes);
  void publishSpan({
    traceId: traceId,
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

  const attemptTrackedModel = wrapLanguageModel({
    model: configuredModel.model,
    middleware: attemptRecordingMiddleware(stepTiming.recordAttempt, (error) =>
      redactSensitiveText(
        toErrorMessage(error),
        getObservabilityContext()?.secretValues,
      ),
    ),
  });

  const maxTurn = agentConfig.agent?.maxTurn ?? MAX_AGENT_ITERATIONS;
  const deadline = createDeadlinePolicy({
    deadlineMs: options.deadlineMs,
    canYield: options.canYield === true,
    windDownMs: DEADLINE_WIND_DOWN_MS,
    maxTurn: maxTurn,
    now: Date.now,
  });
  const aiRuntimeContext = {
    traceName: rootSpanName,
    properties: process.env.DEPLOYMENT_ENVIRONMENT
      ? { environment: process.env.DEPLOYMENT_ENVIRONMENT }
      : {},
  };
  const streamOptions: Parameters<typeof streamText>[0] = {
    maxOutputTokens: 16000,
    ...modelSettings,
    model: attemptTrackedModel,
    instructions: turnContext.system,
    // The live environment goes last so everything before it stays a cached prefix.
    messages: withEnvironment(
      stripEnvelopeFieldsFromMessages(turnContext.messages),
      environment,
      cacheBreakpoint,
    ),
    ...(modelOutput ? { output: modelOutput } : {}),
    ...(enabledTools ? { tools: enabledTools } : {}),
    ...(toolApproval ? { toolApproval: toolApproval } : {}),
    ...(providerOptions ? { providerOptions: providerOptions as never } : {}),
    runtimeContext: aiRuntimeContext,
    // Inputs and outputs off: our own span rows carry them, redacted.
    telemetry: {
      functionId: "harness.agent",
      includeRuntimeContext: {
        traceName: true,
        properties: true,
      },
      recordInputs: false,
      recordOutputs: false,
    },
    stopWhen: [
      ...(maxTurn === AGENT_MAX_TURN_UNLIMITED ? [] : [isStepCount(maxTurn)]),
      (): boolean => questionSummaries.length > 0,
      ({ steps }): boolean =>
        deadline.shouldStop(steps.length, questionSummaries.length),
    ],
    abortSignal: runAbort.signal,
    prepareStep: async ({ messages, responseMessages }) => {
      // One mutation: a turn whose step failed to store or stopped never claims a steer.
      const { renewal, steering } = await session.stepBoundary(
        responseMessages.slice(persistedResponseCount),
        { claimSteering: !deadline.isWindingDown() },
      );
      if (renewal === "stopped") {
        throw new Error(stopMessage);
      }
      if (renewal === "stale") {
        throw new Error(
          "Conversation ownership changed before the next model step",
        );
      }
      persistedResponseCount = responseMessages.length;
      let stepMessages = messages;
      if (steering) {
        const steeringEvents = steering.events as ConversationIngressEvent[];
        const steeringSystem =
          await session.appendIngressEvents(steeringEvents);
        turnContext.ephemeralSystem.push(...steeringSystem);
        stepMessages = [
          ...messages,
          ...(await steeringModelMessages(
            steeringEvents,
            agentConfig,
            session.accountId,
          )),
        ];
        logInfo("Steering ingress applied at AI SDK step boundary", {
          eventId: session.eventId,
          conversationKey: session.conversationKey,
          steeringEventCount: steering.contributingEventIds.length,
          appliedMode: steering.appliedMode,
        });
      }
      const parentMessages =
        (await options.subagentWatch?.takeParentMessages()) ?? [];
      if (parentMessages.length > 0) {
        stepMessages = [...stepMessages, ...parentMessages];
        logInfo("Subagent messages applied at AI SDK step boundary", {
          eventId: session.eventId,
          messageCount: parentMessages.length,
        });
      }
      const refreshed = await session.loadRefreshedSystemPromptParts({
        systemContextSnapshot: systemContextSnapshot,
        ephemeralSystem: turnContext.ephemeralSystem,
      });
      systemContextSnapshot = refreshed.systemContextSnapshot;
      // The next run starts with the stored system prompt, so the breakpoint ends there.
      const instructions = withCacheBreakpoint(
        refreshed.system,
        cacheBreakpoint,
        refreshed.storedSystemEnd,
      );
      turnContext.system = refreshed.system;
      if (deadline.isWindingDown()) {
        logInfo("Run winding down before its deadline", {
          eventId: session.eventId,
          conversationKey: session.conversationKey,
        });

        return {
          instructions: [
            ...instructions,
            { role: "system", content: WIND_DOWN_INSTRUCTION },
          ],
          toolChoice: "none",
          ...(stepMessages !== messages ? { messages: stepMessages } : {}),
        };
      }

      return {
        instructions: instructions,
        ...(stepMessages !== messages ? { messages: stepMessages } : {}),
      };
    },
    onChunk: ({ chunk }) => {
      stepTiming.recordChunk(chunk.type, Date.now());
    },
    onStepStart: async ({ stepNumber, messages }) => {
      startApprovalStep();
      const now = Date.now();
      stepTiming.startStep(stepNumber, now);
      spans.open("model.step", stepNumber, now, undefined, {
        "agent.step_number": stepNumber,
        "step.state": "running",
        "model.input": traceAttribute(messagesWithoutMediaBytes(messages)),
        ...systemTraceAttributes(turnContext.system, traceAttribute),
      });
    },
    onToolExecutionStart: async ({ toolCall }) => {
      // Before any await: the SDK gets here in the model's call order.
      reserveComputerTurn(toolCall);
      const stepNumber = stepTiming.activeStep();
      const now = Date.now();
      if (
        stepNumber !== undefined &&
        stepTiming.stepStartMs(stepNumber) === undefined
      ) {
        stepTiming.startStep(stepNumber, now);
      }
      const parent =
        stepNumber !== undefined ? spans.get(stepNumber) : undefined;
      spans.open("tool.call", toolCall.toolCallId, now, parent, {
        "tool.name": toolCall.toolName,
        "tool.call_id": toolCall.toolCallId,
        "tool.state": "running",
        "tool.input": traceAttribute(toolCall.input),
        ...(stepNumber !== undefined
          ? { "agent.step_number": stepNumber }
          : {}),
      });
      toolStepNumbers.set(toolCall.toolCallId, stepNumber);
      recordToolCallSummary(toolCallSummaries, toolCall, {
        stepNumber: stepNumber,
      });
      await lifecycle.emit("tool.call.started", {
        stepNumber: stepNumber,
        toolCall: toLifecycleValue(toolCall),
      });
    },
    onToolExecutionEnd: async ({ toolCall, toolExecutionMs, toolOutput }) => {
      const stepNumber = toolStepNumbers.get(toolCall.toolCallId);
      toolStepNumbers.delete(toolCall.toolCallId);
      const output =
        toolOutput.type === "tool-result" ? toolOutput.output : undefined;
      const error =
        toolOutput.type === "tool-error" ? toolOutput.error : undefined;
      const toolEndMs = Date.now();
      const openSpan = spans.get(toolCall.toolCallId);
      const toolDurationMs = toolSpanDurationMs(
        openSpan?.startTimeMs ?? toolEndMs,
        toolEndMs,
        toolExecutionMs,
      );
      const tracked =
        openSpan ??
        spans.late("tool.call", toolEndMs - toolDurationMs, {
          "tool.name": toolCall.toolName,
          "tool.call_id": toolCall.toolCallId,
        });
      const toolSpanEndMs = tracked.startTimeMs + toolDurationMs;
      const toolInput =
        tracked.attributes["tool.input"] ?? traceAttribute(toolCall.input);
      const outputErrorText = toolOutputErrorText(output);
      const toolSucceeded =
        toolOutput.type === "tool-result" && !outputErrorText;
      const errorText = toolSucceeded
        ? undefined
        : redactSensitiveText(
            outputErrorText ?? errorMessage(error),
            getObservabilityContext()?.secretValues,
          );
      const compute = sandboxCpu.takeToolCompute(toolCall.toolCallId);
      const computeAttributes = compute
        ? {
            "tool.compute.type": compute.type,
            "tool.compute.cpu_usec": compute.cpuUsec,
          }
        : {};
      const outputAttributes = toolSucceeded
        ? { "tool.output": traceAttribute(outputWithoutMediaBytes(output)) }
        : {};
      spans.close(
        tracked,
        toolSpanEndMs,
        toolSucceeded ? "ok" : "error",
        {
          "tool.state": toolSucceeded ? "completed" : "failed",
          "tool.input": toolInput,
          ...computeAttributes,
          ...outputAttributes,
          ...(stepNumber !== undefined
            ? { "agent.step_number": stepNumber }
            : {}),
        },
        errorText,
      );

      recordToolCallSummary(toolCallSummaries, toolCall, {
        stepNumber: stepNumber,
        durationMs: toolDurationMs,
        success: toolSucceeded,
      });
      await lifecycle.emit("tool.call.finished", {
        stepNumber: stepNumber,
        toolCall: toLifecycleValue(toolCall),
        durationMs: toolDurationMs,
        success: toolSucceeded,
        ...(toolSucceeded ? {} : { error: errorText ?? errorMessage(error) }),
      });
      const details = {
        eventType: toolSucceeded ? "tool.call.finished" : "tool.call.failed",
        ...logContext,
        stepNumber: stepNumber,
        toolName: toolCall.toolName,
        toolCallId: toolCall.toolCallId,
        durationMs: toolDurationMs,
      };

      if (toolSucceeded) {
        logInfo(
          `Tool call finished: ${toolCall.toolName} in ${formatDuration(toolDurationMs)}`,
          details,
        );

        return;
      }

      logError(
        `Tool call failed: ${toolCall.toolName} in ${formatDuration(toolDurationMs)}${errorText ? `: ${errorText}` : ""}`,
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
      const startedAt = stepTiming.stepStartMs(stepNumber);
      const durationMs =
        startedAt === undefined ? undefined : Date.now() - startedAt;
      const stepText = (text ?? "").trim();
      if (stepText) {
        lastStepText = stepText;
      }
      for (const toolCall of toolCalls) {
        recordToolCallSummary(toolCallSummaries, toolCall, {
          stepNumber: stepNumber,
        });
      }

      const stepTokens = usageTokenTotals(usage);
      const stepCacheWriteTokens = taskTotals.addStep(
        stepNumber,
        stepTokens,
        extractCacheWriteTokens(configuredModel.providerName, providerMetadata),
      );

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
            toolCallId: toolCallId,
            toolName: toolName,
          })),
          usage: usage,
          responseMetadata: {
            id: response.id,
            modelId: response.modelId,
            timestamp: response.timestamp.toISOString(),
          },
          providerMetadata: providerMetadata,
        },
      );

      const tracked = spans.get(stepNumber);
      if (tracked) {
        const stepEndMs = Date.now();
        // The dashboard sums live usage off these spans; there is no separate usage channel.
        spans.close(tracked, stepEndMs, "ok", {
          "agent.step_number": stepNumber,
          "step.state": "completed",
          "model.finish_reason": finishReason,
          "agent.tool_call_count": toolCalls.length,
          ...stepTiming.closeStep(stepNumber, stepEndMs),
          ...modelTokenAttributes({
            ...stepTokens,
            cacheWriteTokens: stepCacheWriteTokens,
          }),
          "model.response": traceAttribute(text),
          "model.reasoning": traceAttribute(reasoningText ?? ""),
          "model.tool_calls": traceAttribute(toolCalls),
          "model.tool_results": traceAttribute(
            toolResults.map((result) => ({
              ...result,
              output: outputWithoutMediaBytes(result.output),
            })),
          ),
        });
      }
      const liveRoleCpu = sandboxCpu.roleAttributes();
      if (Object.keys(liveRoleCpu).length > 0) {
        void publishSpan({
          traceId: traceId,
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
      stepTiming.endActiveStep(stepNumber);
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

      await reply?.onErrorText(errorText).catch(() => {});
      await announceFailure(errorText);
      if (isContextLengthError(errorText)) {
        await autoCompact(undefined, true);
      }
    },
    onEnd: async ({
      response,
      responseMessages,
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
      taskTotals.finish(usage, stepCount);
      const approvalRequests = extractApprovalRequests(steps);
      // `isAutomatic`: the SDK already answered it this run, so it must not gate the turn.
      const approvals = approvalRequests
        .filter((request) => !request.isAutomatic)
        .map(summarizeApprovalRequest);
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
        usage: taskTotals.usage(),
      };

      try {
        const unpersisted = responseMessages.slice(persistedResponseCount);
        await session.persistModelMessages(
          approvalRequests.length > 0
            ? withApprovalToolCalls(unpersisted, approvalRequests)
            : unpersisted,
        );
        persistedResponseCount = responseMessages.length;

        // A yielded run's next pass answers from these results; a pending approval wins.
        if (approvals.length > 0) deadline.withdrawYield();
        if (deadline.hasYielded()) {
          logInfo(
            `Run yielded its worker slot after ${stepCount} step(s)`,
            finishLog,
          );

          return;
        }

        const deliveredByTool =
          finishReason === "stop" &&
          tools.toolCalls.some(
            (toolCall) =>
              DELIVERY_TOOL_NAMES.has(toolCall.toolName) &&
              toolCall.success === true,
          );
        if (
          approvals.length === 0 &&
          questionSummaries.length === 0 &&
          !modelOutput &&
          !finalText &&
          !deliveredByTool
        ) {
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
              usage: taskTotals.usage(),
            },
          );
          await reply?.onErrorText(errorText).catch(() => {});
          await announceFailure(errorText, {
            finishReason: finishReason,
            stepCount: stepCount,
            toolCallCount: toolCallCount,
          });

          return;
        }

        // Logged before parsing and delivery: the spend is real even if those fail.
        logInfo(
          `Model invocation finished: ${finishReason}, ${stepCount} step(s), ${toolCallCount} tool call(s), ${tools.toolsUsed.length > 0 ? `tools ${tools.toolsUsed.join(", ")}, ` : ""}${formatUsageSummary(taskTotals.usage())}, ${formatDuration(finishLog.durationMs)}`,
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
          // A returned { approve } is not honored: approval continuation belongs to the handler.
          if (hooks.hasHooksFor("agent.approval.required")) {
            await hooks.runMutation("agent.approval.required", {
              approvals: toLifecycleValue(approvals),
            });
          }
          await reply?.onApprovalRequired?.(approvals);

          return;
        }
        if (questionSummaries.length > 0) {
          await reply?.onQuestionsPending?.(questionSummaries);

          return;
        }

        if (modelOutput) {
          finalResponse = (await modelOutput.parseCompleteOutput(
            { text: text },
            { response: response, usage: usage, finishReason: finishReason },
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
          await autoCompact(steps.at(-1)?.usage.inputTokens);

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
        await autoCompact(steps.at(-1)?.usage.inputTokens);
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

        await reply?.onErrorText(errorText).catch(() => {});
        await announceFailure(errorText);
      } finally {
        await finalizer.finalize(
          didFail ? "failed" : "completed",
          toolCallCount,
          Date.now() - runStartedAt,
          terminalError,
        );
      }
    },
  };
  let harnessTurn: HarnessTurn | undefined;
  let stream: ReturnType<typeof streamText>;
  try {
    if (usesAiSdkHarness) {
      if (policyToolApproval) {
        throw new Error(
          "config.policy is not supported with config.harness because the upstream harness accepts only static host-tool approvals",
        );
      }
      harnessTurn = await prepareHarnessTurn({
        abortController: runAbort,
        agentConfig: agentConfig,
        agentReservationKey: agentMachineKey,
        applySteering: (): Promise<void> =>
          applyHarnessSteeringBeforeTurn(session, turnContext, agentConfig),
        configuredApprovals: configuredApprovals,
        createAgent: createConfiguredHarnessAgent,
        isolated: options.isolatedSandbox === true,
        metadata: sandboxMetadata,
        onOccupied: (release): void => {
          releaseSandboxOccupancy = release;
        },
        openSession: openAiSdkHarnessSession,
        sandbox: sandboxes[0],
        session: session,
        stopMessage: stopMessage,
        tools: tools,
        turnContext: turnContext,
      });
      activeHarnessSession = harnessTurn.nativeSession;
      rootRunningAttributes = {
        ...rootRunningAttributes,
        "agent.environment": traceAttribute(harnessTurn.environment),
      };
      otelRootSpan.setAttributes(rootRunningAttributes);
    }
    stream = harnessTurn
      ? await harnessTurn.runtime.agent.stream({
          messages: harnessPromptMessages(
            stripEnvelopeFieldsFromMessages(turnContext.messages),
            harnessTurn.environment,
            harnessTextBeforeImages(agentConfig.harness!.type),
          ),
          session: harnessTurn.nativeSession,
          abortSignal: runAbort.signal,
          // No onEnd: finalizeHarnessStream calls it once the native session is parked.
          onStepStart:
            harnessSteersMidTurn(agentConfig.harness!.type) &&
            !MID_TURN_STEERING_UNSUPPORTED.has(agentConfig.harness!.type)
              ? async (event): Promise<void> => {
                  await streamOptions.onStepStart?.(event);
                  // A claimed steer not saved or handed over must settle failed, not seen.
                  await steerHarnessTurn(
                    session,
                    activeHarnessSession!,
                    agentConfig.harness!.type,
                  ).catch((error: unknown): void => runAbort.abort(error));
                }
              : streamOptions.onStepStart,
          onStepEnd: streamOptions.onStepEnd,
          onToolExecutionStart: streamOptions.onToolExecutionStart,
          onToolExecutionEnd: streamOptions.onToolExecutionEnd,
        })
      : streamText(streamOptions);
  } catch (error) {
    await harnessTurn?.dispose();
    didFail = true;
    const message = errorMessage(error);
    failureText = message;
    terminalError = error instanceof Error ? error : new Error(message);
    await reply?.onErrorText(message).catch(() => {});
    await announceFailure(message);
    await finalizer.finalize(
      "failed",
      toolCallSummaries.size,
      Date.now() - runStartedAt,
      terminalError,
    );
    throw terminalError;
  }
  void watchModelStream(stream.fullStream, usesAiSdkHarness, (error): void => {
    if (runAbort.signal.aborted) return;
    terminalError ??= error;
    runAbort.abort(error);
  });
  let harnessStreamFinalized = false;
  const finalizeHarnessStream = async (
    streamError?: unknown,
  ): Promise<void> => {
    if (!activeHarnessSession || harnessStreamFinalized) {
      return;
    }
    harnessStreamFinalized = true;
    harnessTurn?.stopLeaseMonitor();
    const abortError = runAbort.signal.aborted
      ? runAbort.signal.reason
      : undefined;
    let finalizationError = streamError ?? abortError;
    try {
      await parkAiSdkHarnessSession({
        broodsSession: session,
        nativeSession: activeHarnessSession,
        reservationKey: harnessTurn?.reservationKey ?? session.conversationKey,
        successful: finalizationError === undefined,
        type: agentConfig.harness!.type,
      });
    } catch (error) {
      const message = errorMessage(error);
      finalizationError ??= error instanceof Error ? error : new Error(message);
    } finally {
      activeHarnessSession = undefined;
    }
    if (!finishObserved && finalizationError !== undefined) {
      await streamOptions.onError?.({ error: finalizationError } as never);
    } else if (!finishObserved) {
      try {
        await streamOptions.onEnd?.({
          response: await stream.response,
          responseMessages: await stream.responseMessages,
          text: await stream.text,
          finishReason: await stream.finishReason,
          rawFinishReason: await stream.rawFinishReason,
          steps: await stream.steps,
          toolCalls: await stream.toolCalls,
          usage: await stream.usage,
        } as never);
      } catch (error) {
        await streamOptions.onError?.({ error: error } as never);
      }
    }
  };

  const originalConsumeStream = stream.consumeStream.bind(stream);
  // The SDK skips onEnd when a run errors early, so this settles the run then.
  const ensureFinalized = async (drained: boolean): Promise<void> => {
    if (!drained && !finishObserved) {
      terminalError ??= new Error("Caller stopped reading the stream");
      runAbort.abort(terminalError);
    }
    if (!drained && finishObserved && !finalizer.finalized()) {
      // onEnd is still persisting; the SDK closes the stream only after it returns.
      try {
        await originalConsumeStream();
      } catch {
        // Falls through to the failed finalization below.
      }
    }
    await finalizeHarnessStream();
    if (!finishObserved) {
      didFail = true;
      terminalError ??= new Error(
        "Model stream ended without a completion callback",
      );
      failureText ??= terminalError.message;
      await announceFailure(failureText);
    }
    await finalizer.finalize(
      "failed",
      toolCallSummaries.size,
      Date.now() - runStartedAt,
      terminalError,
    );
  };

  const wrappedConsumeStream = async (): Promise<void> => {
    try {
      await originalConsumeStream();
    } catch (error) {
      await finalizeHarnessStream(error);
      didFail = true;
      const errorText = errorMessage(error);
      failureText ??= errorText;
      terminalError ??= error instanceof Error ? error : new Error(errorText);
      throw error;
    } finally {
      await ensureFinalized(true);
    }
  };

  return Object.assign(stream, {
    consumeStream: wrappedConsumeStream,
    ensureFinalized: ensureFinalized,
    didFail: (): boolean => didFail,
    yielded: (): boolean => deadline.hasYielded() && !didFail,
    failureText: (): string | null => failureText,
    approvalSummaries: (): ToolApprovalSummary[] => approvalSummaries,
    questionSummaries: (): PendingQuestionSummary[] => questionSummaries,
    hasStructuredOutput: (): boolean => Boolean(modelOutput),
    finalResponse: (): JSONValue | undefined => finalResponse,
    traceId: (): string => traceId,
  });
}

// A turn that failed before runAgentLoop opened its root span, on the trace id its logs carry.
export function recordFailedTurn(
  session: Session,
  startedAt: number,
  error: unknown,
): void {
  const context = getObservabilityContext();
  const traceId = context?.traceId ?? mintTraceId();
  const scope = sessionObservabilityScope(session);
  const kind: ObservabilitySpanRow["kind"] = session.trigger ?? "task";
  const name = `agent.${kind}`;
  const message = redactSensitiveText(
    errorMessage(error),
    context?.secretValues,
  );
  const endTimeMs = Date.now();
  const otelSpan = getTracer().startSpan(
    name,
    {
      startTime: startedAt,
      attributes: { ...observabilityAttributes(scope), "task.state": "failed" },
    },
    otelTraceApi.setSpanContext(otelContextApi.active(), {
      traceId: traceId,
      spanId: mintSpanId(),
      traceFlags: TraceFlags.SAMPLED,
    }),
  );
  otelSpan.setStatus({ code: SpanStatusCode.ERROR, message: message });
  otelSpan.end(endTimeMs);
  const spanId = otelSpan.spanContext().spanId;
  void publishSpan({
    traceId: traceId,
    spanId: /[^0]/.test(spanId) ? spanId : mintSpanId(),
    name: name,
    kind: kind,
    startTimeMs: startedAt,
    endTimeMs: endTimeMs,
    durationMs: endTimeMs - startedAt,
    status: "error",
    endpointId: session.endpointId,
    agentId: session.agentId,
    conversationKey: session.conversationKey,
    attributes: { "task.state": "failed" },
    error: message,
  });
}

// /compact never enters runAgentLoop, so it records its own trace and usage row.
export function runCompactCommand(
  session: Session,
  input: string,
  instructions: string,
): Promise<number> {
  const startedAt = Date.now();
  const kind: ObservabilitySpanRow["kind"] = session.trigger ?? "task";
  const root = startRunRoot(session, `agent.${kind}`, startedAt);

  return runWithObservabilityScope(
    async (): Promise<number> => {
      let outcome: CompactionOutcome | undefined;
      try {
        const result = await session.compactConversation(instructions);
        outcome = result ? { result: result } : undefined;
      } catch (err) {
        outcome = {
          error: err instanceof Error ? err : new Error(errorMessage(err)),
        };
      }
      // An unended root is never exported, so a no-op leaves no trace.
      if (outcome) {
        await recordCompactionTask(
          session,
          input,
          kind,
          root,
          startedAt,
          outcome,
        ).catch((err: unknown): void => {
          logError("Recording the /compact run failed", {
            conversationKey: session.conversationKey,
            error: errorMessage(err),
          });
        });
      }
      if (outcome && "error" in outcome) throw outcome.error;

      return outcome?.result.messageCount ?? 0;
    },
    {
      ...sessionObservabilityScope(session),
      traceId: root.traceId,
      otelContext: root.otelContext,
      secretValues: session.secretValues(),
    },
  );
}

export function latestUserText(messages: ModelMessage[]): string {
  const message = messages.findLast(
    (candidate): candidate is UserModelMessage => candidate.role === "user",
  );

  return message ? extractText(message.content).trim() : "";
}

export function systemTraceAttributes(
  system: SystemModelMessage[],
  serialize: (value: unknown) => string,
): Record<string, string | number> {
  return {
    "model.system": serialize(
      system.map((message) => message.content).join("\n\n"),
    ),
    "model.system_part_count": system.length,
    "model.system_chars": system.reduce(
      (total, message) => total + message.content.length,
      0,
    ),
  };
}

// The handler clock is a fallback: it overstates parallel calls by the model's own time.
export function toolSpanDurationMs(
  startTimeMs: number,
  handlerNowMs: number,
  toolExecutionMs: number | undefined,
): number {
  if (typeof toolExecutionMs === "number" && Number.isFinite(toolExecutionMs)) {
    return Math.max(0, toolExecutionMs);
  }

  return Math.max(0, handlerNowMs - startTimeMs);
}

function errorMessage(error: unknown): string {
  const rawMessage = toErrorMessage(error);
  // Reaches the end user via reply.onErrorText, so it gets the telemetry secret scrubbing.
  const message = redactSensitiveText(
    rawMessage,
    getObservabilityContext()?.secretValues,
  );
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

async function applyHarnessSteeringBeforeTurn(
  session: Session,
  turnContext: TurnContextSnapshot,
  agentConfig: AgentConfig,
): Promise<void> {
  let steeringEventCount = 0;
  for (;;) {
    const steering = await session.applySteeringIngress();
    if (!steering) {
      break;
    }
    const events = steering.events as ConversationIngressEvent[];
    const ephemeralSystem = await session.appendIngressEvents(events);
    turnContext.ephemeralSystem.push(...ephemeralSystem);
    turnContext.messages.push(
      ...(await steeringModelMessages(events, agentConfig, session.accountId)),
    );
    steeringEventCount += steering.contributingEventIds.length;
  }
  if (steeringEventCount === 0) {
    return;
  }
  const refreshed = await session.loadRefreshedSystemPromptParts({
    systemContextSnapshot: turnContext.systemContextSnapshot,
    ephemeralSystem: turnContext.ephemeralSystem,
  });
  turnContext.system = refreshed.system;
  turnContext.systemContextSnapshot = refreshed.systemContextSnapshot;
  logInfo("Steering ingress applied before HarnessAgent turn", {
    eventId: session.eventId,
    conversationKey: session.conversationKey,
    steeringEventCount: steeringEventCount,
  });
}

async function steeringModelMessages(
  events: ConversationIngressEvent[],
  agentConfig: AgentConfig,
  accountId: string | undefined,
): Promise<ModelMessage[]> {
  return await rehydrateStoredMedia(
    stripEnvelopeFieldsFromMessages(
      events.filter(
        (
          event,
        ): event is Exclude<ConversationIngressEvent, SystemModelMessage> =>
          event.role !== "system",
      ),
    ),
    agentConfig,
    accountId,
  );
}

// Rides on the person's last message when it ends the history, so the model reads one request.
function withEnvironment(
  messages: ModelMessage[],
  environment: string,
  breakpoint?: ProviderOptions,
): ModelMessage[] {
  const last = messages.at(-1);
  if (last?.role === "tool" && breakpoint !== undefined) {
    // OpenAI reads a tool result's breakpoint off the part, never the message;
    // Anthropic takes the last part's mark as the message's.
    const index = last.content.findLastIndex(
      (part): boolean => part.type === "tool-result",
    );

    return [
      ...messages.slice(0, -1),
      {
        ...last,
        content: last.content.map((part, partIndex) =>
          partIndex === index && part.type === "tool-result"
            ? markedForCache(part, breakpoint)
            : part,
        ),
      },
      { role: "user", content: environment },
    ];
  }
  if (last?.role !== "user") {
    return [
      ...withCacheBreakpoint(messages, breakpoint),
      { role: "user", content: environment },
    ];
  }
  const content =
    typeof last.content === "string"
      ? [{ type: "text" as const, text: last.content }]
      : last.content;

  return [
    ...messages.slice(0, -1),
    {
      ...last,
      content: [
        ...withCacheBreakpoint(content, breakpoint),
        { type: "text", text: environment },
      ],
    },
  ];
}

function harnessPromptMessages(
  messages: ModelMessage[],
  environment: string,
  textBeforeImages: boolean,
): ModelMessage[] {
  const lastMessage = messages.at(-1);
  if (lastMessage?.role === "tool") {
    const assistantIndex = messages.findLastIndex(
      (message, index) =>
        index < messages.length - 1 && message.role === "assistant",
    );
    if (assistantIndex >= 0) {
      return [messages[assistantIndex]!, lastMessage];
    }

    return [lastMessage];
  }
  const lastAssistantIndex = messages.findLastIndex(
    (message) => message.role === "assistant",
  );
  const userMessages = messages
    .slice(lastAssistantIndex + 1)
    .filter((message): message is UserModelMessage => message.role === "user");
  if (userMessages.length === 0) {
    throw new Error(
      "AI SDK Harness turn requires a new user message or an unfinished tool continuation",
    );
  }
  const content = userMessages.flatMap(
    (message): Array<TextPart | ImagePart | FilePart> =>
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content.map((part): TextPart | ImagePart | FilePart =>
            part.type === "text" || harnessReadsMedia(part)
              ? part
              : {
                  type: "text",
                  text: unreadableMediaNote(
                    part.type === "file" ? part.filename : undefined,
                    part.mediaType ?? "image",
                  ),
                },
          ),
  );
  content.push({ type: "text", text: environment });

  return [
    {
      role: "user",
      content: textBeforeImages
        ? [
            ...content.filter((part): boolean => part.type === "text"),
            ...content.filter((part): boolean => part.type !== "text"),
          ]
        : content,
    },
  ];
}

function harnessReadsMedia(part: ImagePart | FilePart): boolean {
  try {
    extractHarnessPromptContent({ prompt: { role: "user", content: [part] } });

    return true;
  } catch (error) {
    if (HarnessCapabilityUnsupportedError.isInstance(error)) {
      return false;
    }
    throw error;
  }
}

// Not the SDK's `timeout`: its firstChunkMs starts only once a response arrives, and
// HarnessAgent ignores it. The clock stops while a tool runs; on streamText a
// provider-executed call streams from the model itself, so only a harness's stops it.
async function watchModelStream(
  parts: AsyncIterable<TextStreamPart<ToolSet>>,
  harness: boolean,
  fail: (error: Error) => void,
): Promise<void> {
  const firstChunkMs = positiveIntegerEnv(
    "MODEL_FIRST_CHUNK_TIMEOUT_MS",
    DEFAULT_MODEL_FIRST_CHUNK_TIMEOUT_MS,
  );
  const chunkMs = positiveIntegerEnv(
    "MODEL_CHUNK_TIMEOUT_MS",
    DEFAULT_MODEL_CHUNK_TIMEOUT_MS,
  );
  const openToolCalls = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (limitMs: number): void => {
    clearTimeout(timer);
    if (openToolCalls.size > 0) return;
    timer = setTimeout((): void => {
      fail(
        new Error(
          `The model sent no output for ${Math.ceil(limitMs / 1000)}s, so the run was stopped`,
        ),
      );
    }, limitMs);
    timer.unref?.();
  };
  arm(firstChunkMs);
  try {
    for await (const part of parts) {
      if (part.type === "finish") break;
      if (
        part.type === "tool-call" &&
        (harness || part.providerExecuted !== true)
      ) {
        openToolCalls.add(part.toolCallId);
      } else if (
        part.type === "tool-result" ||
        part.type === "tool-error" ||
        part.type === "tool-output-denied"
      ) {
        openToolCalls.delete(part.toolCallId);
      }
      if (MODEL_CALL_BOUNDARY_PART_TYPES.has(part.type)) {
        arm(firstChunkMs);
      } else if (MODEL_CONTENT_CHUNK_TYPES.has(part.type)) {
        arm(chunkMs);
      }
    }
  } catch {
    // The run's own reader reports a failed stream.
  } finally {
    clearTimeout(timer);
  }
}

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

function publishSpan(row: ObservabilitySpanRow): Promise<void> {
  const connPromise = getSharedNatsConn();
  if (!connPromise) return Promise.resolve();

  const ctx = getObservabilityContext();
  if (!ctx || !ctx.endpointId || !ctx.project || !ctx.stage)
    return Promise.resolve();

  const subject = tracesSubject(
    ctx.accountId,
    ctx.project,
    ctx.stage,
    ctx.endpointId,
  );

  return connPromise
    .then(async (conn) => {
      // So a cold container's first span lands for replay; the live publish works without it.
      await ensureObservabilityStream(conn).catch(() => {});
      conn.publish(subject, SPAN_ENCODER.encode(JSON.stringify(row)));
    })
    .catch(() => {});
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
    // Ephemeral too, so it survives each prepareStep system refresh.
    turnContext.ephemeralSystem = [...turnContext.ephemeralSystem, message];
  }
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

// On SSE the tokens are already sent: this changes the stored and delivered result only.
async function foldAgentFinished(
  hooks: HookDispatcher,
  response: JSONValue,
  finishReason: string,
): Promise<JSONValue> {
  if (!hooks.hasHooksFor("agent.finished")) {
    return response;
  }
  const mutation = await hooks.runMutation("agent.finished", {
    finishReason: finishReason,
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
  toolCall: TypedToolCall<ToolSet>,
  update: Partial<Omit<ToolCallSummary, "toolCallId" | "toolName">>,
): void {
  const existing = summaries.get(toolCall.toolCallId);
  summaries.set(toolCall.toolCallId, {
    ...existing,
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    ...update,
  });
}

function summarizeToolsUsed(summaries: Map<string, ToolCallSummary>): {
  toolsUsed: string[];
  toolUsage: Record<string, number>;
  toolCalls: ToolCallSummary[];
} {
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
    toolUsage: toolUsage,
    toolCalls: toolCalls,
  };
}

// The persisted history needs each request's tool call to resume it once approved.
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

    const withToolCalls: AssistantModelMessage = {
      ...message,
      content: content,
    };

    return withToolCalls;
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
  // A provider's own failure payload is the only record of what it said; keep it whole.
  if (!(error instanceof Error)) {
    details.raw = errorObject;
  }

  return details;
}

function messagesWithoutMediaBytes(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message): ModelMessage => {
    if (message.role === "tool") {
      return {
        ...message,
        content: message.content.map((part) =>
          part.type === "tool-result"
            ? { ...part, output: toolOutputWithoutMediaBytes(part.output) }
            : part,
        ),
      };
    }
    if (message.role !== "user" || typeof message.content === "string") {
      return message;
    }

    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type === "image" && part.image instanceof Uint8Array) {
          return {
            ...part,
            image: `[${part.mediaType ?? "image"}, ${Math.round(part.image.byteLength / 1024)} KB]`,
          };
        }

        return part.type === "file" && part.data instanceof Uint8Array
          ? {
              ...part,
              data: `[${part.mediaType}, ${Math.round(part.data.byteLength / 1024)} KB]`,
            }
          : part;
      }),
    };
  });
}

function outputWithoutMediaBytes(output: unknown): unknown {
  const parsed = parseToolResultOutput(output);

  return parsed ? toolOutputWithoutMediaBytes(parsed) : output;
}

function toolOutputWithoutMediaBytes(
  output: ToolResultOutput,
): ToolResultOutput {
  if (output.type !== "content") return output;

  return {
    ...output,
    value: output.value.map((part) =>
      part.type === "image-data" || part.type === "file-data"
        ? {
            ...part,
            data: `[${part.mediaType} base64, ${Math.round((part.data.length * 3) / 4 / 1024)} KB]`,
          }
        : part,
    ),
  };
}

function recordCompactionTask(
  session: Session,
  input: string,
  kind: ObservabilitySpanRow["kind"],
  root: RunRoot,
  startedAt: number,
  outcome: CompactionOutcome,
): Promise<void> {
  const context = getObservabilityContext();
  const serialize = (value: unknown): string =>
    redactSerialized(
      value,
      context?.secretValues ?? [],
      MAX_TRACE_ATTRIBUTE_CHARS,
    );
  const taskInput = serialize(input).slice(0, MAX_TASK_INPUT_CHARS);
  const endMs = Date.now();
  const spent =
    "result" in outcome
      ? outcome.result
      : outcome.error instanceof CompactionError
        ? outcome.error.spent
        : undefined;
  if ("result" in outcome) {
    root.spans.phase(
      "phase.compaction",
      "Compaction",
      startedAt,
      endMs,
      compactionSpanAttributes(outcome.result),
    );
  }
  const taskTotals = createTaskTotals();
  if (spent) taskTotals.addCompaction(spent.usage);
  const modelProvider = spent?.modelProvider ?? "unknown";
  const modelId = spent?.modelId ?? "unknown";

  return createRunFinalizer({
    session: session,
    root: {
      span: root.span,
      traceId: root.traceId,
      spanId: root.spanId,
      name: `agent.${kind}`,
      kind: kind,
      startTimeMs: startedAt,
    },
    // The dashboard prices a trace by the model its root names (`runModel`).
    rootAttributes: (): Record<string, string> => ({
      "task.id": session.eventId,
      "task.delivery": session.delivery?.kind ?? "direct",
      "task.input": taskInput,
      "model.provider": modelProvider,
      "model.id": modelId,
    }),
    modelProvider: modelProvider,
    modelId: modelId,
    taskInput: taskInput,
    serialize: serialize,
    spans: root.spans,
    stepTiming: createStepTimingTracker(serialize),
    taskTotals: taskTotals,
    sandboxCpu: createSandboxCpuLedger(),
    openWork: (): Promise<RunOpenWork> => Promise.resolve({ questions: [] }),
    publish: publishSpan,
    recordUsage: recordTaskUsage,
    release: (): void => {},
    restoreObservabilityContext: (): void => {},
  }).finalize(
    "result" in outcome ? "completed" : "failed",
    0,
    endMs - startedAt,
    "error" in outcome ? outcome.error : undefined,
  );
}

// A noop tracer (OTel not initialised) has all-zero ids, so live NATS rows mint their own.
function startRunRoot(
  session: Session,
  name: string,
  startedAt: number,
  parent: OtelContext = otelContextApi.active(),
): RunRoot {
  const tracer = getTracer();
  const scope = sessionObservabilityScope(session);
  const span = tracer.startSpan(
    name,
    { startTime: startedAt, attributes: observabilityAttributes(scope) },
    parent,
  );
  const ids = span.spanContext();
  const traceId = /[^0]/.test(ids.traceId) ? ids.traceId : mintTraceId();
  const spanId = /[^0]/.test(ids.spanId) ? ids.spanId : mintSpanId();
  const otelContext = otelTraceApi.setSpan(parent, span);

  return {
    span: span,
    traceId: traceId,
    spanId: spanId,
    otelContext: otelContext,
    spans: createRunSpanTracker({
      tracer: tracer,
      scope: scope,
      traceId: traceId,
      rootSpanId: spanId,
      rootOtelContext: otelContext,
      session: {
        endpointId: session.endpointId,
        agentId: session.agentId,
        conversationKey: session.conversationKey,
      },
      publish: publishSpan,
    }),
  };
}

function sessionObservabilityScope(
  session: Session,
): Parameters<typeof observabilityAttributes>[0] {
  return {
    accountId: session.accountId ?? "",
    project: session.projectSlug ?? "",
    stage: session.stageSlug ?? "",
    endpointId: session.endpointId ?? "",
    agentId: session.agentId ?? "",
    conversationKey: session.conversationKey,
  };
}
