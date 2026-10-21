/**
 * The model/tool loop for one agent run: streamText or an AI SDK Harness turn,
 * its tracing, usage and lifecycle events. The handler assembles the turn
 * context before it; session.ts loads and saves conversation state.
 */

import {
  NoSuchProviderReferenceError,
  UnsupportedFunctionalityError,
} from "@ai-sdk/provider";
import {
  context as otelContextApi,
  trace as otelTraceApi,
  SpanStatusCode,
  TraceFlags,
} from "@opentelemetry/api";
import {
  isStepCount,
  streamText,
  wrapLanguageModel,
  type AssistantModelMessage,
  type JSONValue,
  type LanguageModelUsage,
  type ModelMessage,
  type StepResult,
  type SystemModelMessage,
  type TextStreamPart,
  type ToolApprovalRequestOutput,
  type ToolCallPart,
  type ToolSet,
  type TypedToolCall,
  type UserModelMessage,
} from "ai";
import type { HarnessAgentSession } from "@ai-sdk/harness/agent";
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
import { isPlainObject } from "../shared/object.ts";
import {
  getObservabilityContext,
  getTracer,
  mintSpanId,
  mintTraceId,
  observabilityAttributes,
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
// Straight from the module, not the entrypoint: tests mock the entrypoint as a
// whole, and this is run-loop plumbing they keep real.
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
import { shouldAutoCompact } from "./compaction.ts";
import { createAgentLifecycleEmitter, toLifecycleValue } from "./lifecycle.ts";
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
import { createRunSpanTracker } from "./run-spans.ts";
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
  usageTokenTotals,
} from "./usage-metering.ts";

/** Default step cap when the agent config sets no `agent.maxTurn`. */
const MAX_AGENT_ITERATIONS = 30;
// A slow model step on a long context can take two minutes, so a run this
// close to its deadline yields its worker slot after the step, or, when it may
// not yield, takes one last step with no tools and no new steers that answers.
// Steers left queued start the next run.
export const DEADLINE_WIND_DOWN_MS = 3 * 60 * 1000;
const WIND_DOWN_INSTRUCTION =
  "This turn is out of time. Reply now with what you have so far and say what is left; the user can ask you to continue.";
// Tools whose successful call already delivered the run's output to a channel
// or another session. Some models (gemini flash) legitimately stop with no
// final text after one of these, so an empty response then is a finished turn,
// not a failure.
const DELIVERY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "send-message",
  "send-files",
  "send-images",
  "send-reactions",
  "send-sticker",
]);
// How long a model may stay silent before its run fails; overridable by
// MODEL_FIRST_CHUNK_TIMEOUT_MS and MODEL_CHUNK_TIMEOUT_MS.
const DEFAULT_MODEL_FIRST_CHUNK_TIMEOUT_MS = 300_000;
const DEFAULT_MODEL_CHUNK_TIMEOUT_MS = 300_000;
// Parts after which the model is starting a new call, not mid-stream.
const MODEL_CALL_BOUNDARY_PART_TYPES: ReadonlySet<string> = new Set([
  "start",
  "start-step",
  "finish-step",
  "tool-result",
  "tool-error",
  "tool-output-denied",
]);
/** Failure text of a stopped run; handler and subagents match on it to treat a stop as intended, not a failure. */
export const USER_STOP_MESSAGE = "Stopped by user at the model boundary";
/** Failure text of a persistent subagent run its parent stopped with stop_subagent. */
export const PARENT_STOP_MESSAGE =
  "Stopped by the parent agent at the model boundary";
// Per-attribute cap on serialized trace payloads. Generous so reasoning and
// tool I/O show in full on the dashboard, still well under the NATS 1MB
// max-payload ceiling.
const MAX_TRACE_ATTRIBUTE_CHARS = 32_000;
// Tracing labels a run with its request. The whole text is already in
// model.input, so this only has to fill one row.
const MAX_TASK_INPUT_CHARS = 500;

const SPAN_ENCODER = new TextEncoder();

type ApprovalRequestOutput = ToolApprovalRequestOutput<ToolSet>;
type ApprovalToolCall = ApprovalRequestOutput["toolCall"];
/** One tool call as the finish and failure logs and lifecycle events report it. */
type ToolCallSummary = {
  toolCallId: string;
  toolName: string;
  stepNumber?: number;
  durationMs?: number;
  success?: boolean;
};

/** A tool call waiting on a person's approval, handed to `onApprovalRequired`. */
export type ToolApprovalSummary = Pick<ApprovalRequestOutput, "approvalId"> & {
  toolCallId: ApprovalToolCall["toolCallId"];
  toolName: ApprovalToolCall["toolName"];
  input: ApprovalToolCall["input"];
};

/** How the caller delivers a run's outcome: final text, error, pending approvals or questions. */
export interface AgentReplyHooks {
  onFinalText(response: JSONValue): Promise<void>;
  onErrorText(error: string): Promise<void>;
  onApprovalRequired?(approvals: ToolApprovalSummary[]): Promise<void>;
  onQuestionsPending?(questions: PendingQuestionSummary[]): Promise<void>;
}

// Link back to the parent task for a subagent run. The subagent is its OWN
// top-level trace (so its waterfall scales to its own duration and it streams
// live like the main agent); it records the parent's trace/task id as a
// "subtask" link, not as a nested child, since a subagent usually runs longer
// than the parent turn.
export interface SubagentParentContext {
  parentTraceId: string;
  parentTaskId: string;
}

// Optional per-run wiring owned by the request handler.
export interface AgentLoopOptions {
  dispatchAppliedIngress?: DispatchAppliedIngress;
  dispatchSubagents?: RunSubagentDispatch;
  subagentWatch?: SubagentWatch;
  // Present on a persistent subagent's run; backs its ask_parent tool.
  askParent?: AskParent;
  dispatchAsyncTools?: RunAsyncToolDispatch;
  dispatchSessionMessage?: RunSessionMessageDispatch;
  // Present when this run is a subagent; links its trace to the parent's.
  subagentParent?: SubagentParentContext;
  // The subagent task asked for a harness machine of its own instead of the
  // agent's shared one. Read on the conversation's first turn only; later turns
  // resume on whatever machine that turn stored.
  isolatedSandbox?: boolean;
  // In-process work the handler still waits on once this pass ends, so its
  // trace closes as waiting rather than ok.
  pendingWork?: () => TaskWaitingOn | undefined;
  // Request-shared hook dispatcher (one storage load + one ctx.state per
  // request); the loop builds its own when the handler does not pass one.
  hooks?: HookDispatcher;
  // Aborts the run from outside, as the worker pool does when it reclaims an
  // overrunning run's slot.
  abortSignal?: AbortSignal;
  // What a stop at a step boundary fails the run with. A persistent subagent's
  // run passes PARENT_STOP_MESSAGE, since its parent's stop_subagent stops it.
  stopMessage?: string;
  // When the request or worker budget ends; the run yields or winds down
  // before it.
  deadlineMs?: number;
  // The worker pool will run the conversation on in another slot, so a run
  // near its deadline stops at a step boundary instead of winding down.
  canYield?: boolean;
  // Test seam for lifecycle webhook delivery, which opens its own pinned
  // socket rather than going through a mockable global.
  webhookTransport?: PinnedFetchTransport;
}

// The agent stream plus the run's control surface: the accessors report loop
// state a caller cannot read off the stream itself, and finalization is exposed
// so a caller that drains the stream by hand can still settle the run.
export type AgentLoopStream = ReturnType<typeof streamText> & {
  consumeStream(): Promise<void>;
  /**
   * `drained` false means the caller stopped reading with the model still
   * running, so the run is aborted before it is settled.
   */
  ensureFinalized(drained: boolean): Promise<void>;
  didFail(): boolean;
  // Stopped at a step boundary to give up its worker slot; nothing delivered.
  yielded(): boolean;
  failureText(): string | null;
  approvalSummaries(): ToolApprovalSummary[];
  questionSummaries(): PendingQuestionSummary[];
  hasStructuredOutput(): boolean;
  finalResponse(): JSONValue | undefined;
  traceId(): string;
};

// Every consumer reads through this so a run is finalized, and aborted when
// the consumer stops early, no matter how the read loop exits. A consumer that
// drains the stream itself when it gives up passes false: the run has to
// survive the early exit for that drain to finish it. `raw` parts never leave
// this reader; the Claude Code harness forwards whole upstream messages as them.
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

/**
 * Runs one model pass for a turn and returns its stream; the handler and
 * subagents read it through `readAgentFullStream`.
 */
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

  // Task-scoped usage accumulators, written by hooks/callbacks, read at finalize.
  const taskTotals = createTaskTotals();
  const sandboxCpu = createSandboxCpuLedger();

  // Start the root span up front so one trace id is on every log line, NATS
  // span row and Tempo span. A noop tracer (OTel not initialised) has all-zero
  // ids, so the live NATS path falls back to freshly minted ones.
  const runStartedAt = Date.now();
  const observabilityScope = {
    accountId: session.accountId ?? "",
    project: session.projectSlug ?? "",
    stage: session.stageSlug ?? "",
    endpointId: session.endpointId ?? "",
    agentId: session.agentId ?? "",
    conversationKey: session.conversationKey,
  };
  const resolvedWorkspaces = session.resolvedWorkspaces();
  const sandboxes = session.sandboxes();
  // A subagent run is its own top-level trace (kind "subtask"), a scheduler run
  // a "cron", anything a person asked for a "task". All three are roots, so
  // each gets its own scaled waterfall.
  const subagentParent = options.subagentParent;
  const rootSpanKind: ObservabilitySpanRow["kind"] = subagentParent
    ? "subtask"
    : (session.trigger ?? "task");
  const rootSpanName = `agent.${rootSpanKind}`;
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
  // The run's model.step, tool.call and phase spans under that root, each an
  // OTel span and a live NATS row.
  const spans = createRunSpanTracker({
    tracer: tracer,
    scope: observabilityScope,
    traceId: traceId,
    rootSpanId: rootSpanId,
    rootOtelContext: rootOtelContext,
    session: {
      endpointId: session.endpointId,
      agentId: session.agentId,
      conversationKey: session.conversationKey,
    },
    publish: publishSpan,
  });
  // The invoking run's identity, mirrored onto any sandbox it reserves so the
  // dashboard activity links back to this trace and task. Shared by the tool
  // registry and the resident-harness reservation.
  const sandboxMetadata: SandboxRunMetadata = {
    traceId: traceId,
    taskId: session.eventId,
    ...(session.agentId ? { agentId: session.agentId } : {}),
    conversationKey: session.conversationKey,
  };
  // Registers this run on the machine it works on so a neighbour's environment
  // counts it; released when usage finalizes.
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

  /** Serializes any value for a span attribute, with run secrets redacted and long text truncated. */
  const traceAttribute = (value: unknown): string =>
    redactSerialized(
      value,
      getObservabilityContext()?.secretValues ?? [],
      MAX_TRACE_ATTRIBUTE_CHARS,
    );

  // A bash-only agent's machine status is read here; a harness run reads its own
  // once the session holds the machine, below.
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
  // Labels the run in Tracing and its row in the usage tab.
  const taskInput = traceAttribute(latestUserText(turnContext.messages)).slice(
    0,
    MAX_TASK_INPUT_CHARS,
  );
  // Reassigned once the tool set is known, so the live root span carries the
  // tools injected into the model alongside its system prompt and messages.
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

  // Cold start is charged to the first run in this execution environment; later
  // (warm) runs consume nothing. Context prepare comes from the turn context
  // the handler assembled before this loop began.
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
        // The handler owns subagent lifecycle, so the loop only forwards the
        // dispatcher into the tool registry for this one model run. Ephemeral
        // system messages are request-local, so pass the current turn copy into
        // child dispatch instead of expecting the coordinator to reload it.
        ...(options.subagentWatch
          ? { subagentWatch: options.subagentWatch }
          : {}),
        ...(options.askParent ? { askParent: options.askParent } : {}),
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
  // Hooks let tool.call.started deny or edit args and tool.result transform
  // output; the owner fence rechecks conversation ownership before each call.
  // Computer actions in one step share a screen, so they run in the model's
  // order, reserved in onToolExecutionStart.
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
  // Per-step timing (ttft, streaming windows, retries), read when each step's
  // span closes.
  const stepTiming = createStepTimingTracker(traceAttribute);
  const toolCallSummaries = new Map<string, ToolCallSummary>();
  const logContext = {
    accountId: session.accountId,
    agentId: session.agentId,
    conversationKey: session.conversationKey,
    eventId: session.eventId,
    modelProvider: configuredModel.providerName,
    modelId: agentConfig.model?.modelId,
  };
  const usesAiSdkHarness = agentConfig.harness !== undefined;
  // Once the model has answered with no tool call left, a long context folds
  // into a summary before the next queued message runs. A turn the provider
  // refused for context length folds too, so the next turn fits. A harness
  // adapter keeps its own context, so its turns never compact the stored one.
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
    let compacted = 0;
    try {
      compacted = await session.compactConversation("");
    } catch (err) {
      logError("Auto-compaction failed; the turn keeps its full history", {
        ...logContext,
        error: errorMessage(err),
      });
    }
    if (compacted > 0) {
      spans.phase("phase.compaction", "Compaction", startedMs, Date.now(), {
        "compaction.message_count": compacted,
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
  // Settles the run exactly once: usage is written once per task and the root
  // OTel span is ended once. Finalization happens after terminal logs/replies so
  // those records retain tenant/trace context. The usage write runs in the
  // background and shutdown drains it before flushing the exporters.
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
  // A user agent.started hook may inject system instructions or replace the
  // message list before the model runs. Fold its result into the turn context.
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

  // Re-publish the running root now that the tool set is resolved and an
  // agent.started hook has had its chance to rewrite the system prompt, so a
  // task that is still running already shows its full injected context.
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
    // A running span has no known end; keep end == start like the first publish.
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
    // History messages carry envelope fields (metadata/createdAt) for hook
    // payloads; the model must see clean AI SDK shapes. The live environment
    // goes last so everything before it stays a cached prefix.
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
    // SDK-native OTel spans (via the @ai-sdk/otel integration registered in
    // initOtel). Inputs/outputs are off: the harness's own span rows already
    // carry redacted response/tool payloads for the dashboard.
    telemetry: {
      functionId: "harness.agent",
      includeRuntimeContext: {
        traceName: true,
        properties: true,
      },
      recordInputs: false,
      recordOutputs: false,
    },
    // A blocking ask_questions call ends the turn after its step; the answer
    // resumes the conversation through the async-tool continuation.
    stopWhen: [
      ...(maxTurn === AGENT_MAX_TURN_UNLIMITED ? [] : [isStepCount(maxTurn)]),
      (): boolean => questionSummaries.length > 0,
      ({ steps }): boolean =>
        deadline.shouldStop(steps.length, questionSummaries.length),
    ],
    abortSignal: runAbort.signal,
    prepareStep: async ({ messages, responseMessages }) => {
      // One mutation stores the step, renews the lease and claims steers, so a
      // steer is never claimed by a turn whose step failed to store or stopped.
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
      // Started after the save, not waited for: the next step does not read
      // the mark, and a failed one only logs.
      void options.subagentWatch?.confirmDelivered();
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
      // Subagent results and questions that arrived during this pass join it
      // here, so the model sees them now instead of in a later pass.
      const parentMessages =
        (await options.subagentWatch?.takeParentMessages()) ?? [];
      if (parentMessages.length > 0) {
        stepMessages = [...stepMessages, ...parentMessages];
        logInfo("Subagent messages applied at AI SDK step boundary", {
          eventId: session.eventId,
          messageCount: parentMessages.length,
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
      // Runs before every step, step 0 too. The next run starts with the stored
      // system prompt, which ends before this run's ephemeral system.
      const instructions = withCacheBreakpoint(
        refreshed.system,
        cacheBreakpoint,
        refreshed.storedSystemEnd,
      );
      // Keep the turn's instructions current: system context grows mid-run
      // (newly persisted rows, steering, skills a tool loaded), and the step and
      // root spans both trace off this.
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
      // Normalize the SDK's duration once, here: it is used as a timestamp and
      // reported on every surface, so a NaN or negative one must not get through.
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
      // Compute is present only for tools that ran off-process, so the pair also
      // tells a reader which runtime served the call.
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
      taskTotals.addStep(
        stepNumber,
        stepTokens,
        extractCacheWriteTokens(configuredModel.providerName, providerMetadata),
      );

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

      // Publish the model.step span (tree: root -> model.step -> tool.call).
      // Tool spans reference this stepSpanId as their parent; without it they
      // would be orphaned in the trace view.
      const tracked = spans.get(stepNumber);
      if (tracked) {
        const stepEndMs = Date.now();
        // Per-step timing and token usage on the span so the dashboard can
        // accumulate live usage straight off the trace stream (no separate
        // usage channel).
        spans.close(tracked, stepEndMs, "ok", {
          "agent.step_number": stepNumber,
          "step.state": "completed",
          "model.finish_reason": finishReason,
          "agent.tool_call_count": toolCalls.length,
          ...stepTiming.closeStep(stepNumber, stepEndMs),
          "model.input_tokens": stepTokens.inputTokens,
          "model.output_tokens": stepTokens.outputTokens,
          "model.reasoning_tokens": stepTokens.reasoningTokens,
          "model.cached_input_tokens": stepTokens.cachedInputTokens,
          "model.total_tokens": stepTokens.totalTokens,
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
      // Re-publish the running root span with the sandbox CPU accumulated so far so
      // the dashboard's Compute chart streams live, not only at finalize. Skipped
      // until a sandbox exec actually reports CPU (keeps NATS traffic minimal).
      const liveRoleCpu = sandboxCpu.roleAttributes();
      if (Object.keys(liveRoleCpu).length > 0) {
        // A running span has no known end; keep end == start, as above.
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

      await lifecycle.emit("agent.failed", {
        error: errorText,
        toolsUsed: toLifecycleValue(tools.toolsUsed),
        toolUsage: toLifecycleValue(tools.toolUsage),
        toolCalls: toLifecycleValue(tools.toolCalls),
      });
      await reply?.onErrorText(errorText).catch(() => {});
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
      // `isAutomatic` records a decision the SDK already answered this run, so
      // only a request still waiting on a human may gate the turn.
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
        await options.subagentWatch?.confirmDelivered();

        // A run that gave up its slot ends on tool results; its next pass
        // answers from them, so nothing is delivered or failed here. A step
        // waiting on an approval stops for that instead.
        if (approvals.length > 0) deadline.withdrawYield();
        if (deadline.hasYielded()) {
          logInfo(
            `Run yielded its worker slot after ${stepCount} step(s)`,
            finishLog,
          );

          return;
        }

        // An empty final text is only a failure when nothing left the run.
        // A model that stopped cleanly after a successful delivery tool call
        // already answered through that tool, and one that stopped on a
        // blocking question is waiting on the person.
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
        // Same exit as an approval: the turn is waiting on the person, so no
        // final text is delivered and nothing settles as completed.
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
      // The trace carries the environment the model actually received.
      rootRunningAttributes = {
        ...rootRunningAttributes,
        "agent.environment": traceAttribute(harnessTurn.environment),
      };
      otelRootSpan.setAttributes(rootRunningAttributes);
    }
    stream = harnessTurn
      ? await harnessTurn.runtime.agent.stream({
          messages: harnessPromptMessages(
            turnContext.messages,
            harnessTurn.environment,
          ),
          session: harnessTurn.nativeSession,
          abortSignal: runAbort.signal,
          // The same step and tool hooks as streamText, so a harness run
          // traces every step. onEnd stays out: finalizeHarnessStream calls it
          // after the native session is parked.
          // Steering that arrives mid-turn joins the running turn at the next
          // step, where the adapter can take it.
          onStepStart:
            harnessSteersMidTurn(agentConfig.harness!.type) &&
            !MID_TURN_STEERING_UNSUPPORTED.has(agentConfig.harness!.type)
              ? async (event): Promise<void> => {
                  await streamOptions.onStepStart?.(event);
                  // A claimed steer that was not saved or handed over fails
                  // the run, so its envelope settles failed, not seen.
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
    await lifecycle.emit("agent.failed", { error: message });
    await reply?.onErrorText(message).catch(() => {});
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
  /**
   * Parks the AI SDK Harness session once its stream ends, and fires onEnd or
   * onError when the harness never did. A no-op for runs without a harness.
   */
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
  /**
   * Settles the run when onEnd never did (the SDK skips it when the run errors
   * early), aborting it first if the caller stopped reading. Called by
   * `readAgentFullStream` and the wrapped consumeStream; idempotent.
   */
  const ensureFinalized = async (drained: boolean): Promise<void> => {
    if (!drained && !finishObserved) {
      terminalError ??= new Error("Caller stopped reading the stream");
      runAbort.abort(terminalError);
    }
    if (!drained && finishObserved && !finalizer.finalized()) {
      // onEnd is still persisting and will finalize the run as completed. The
      // SDK closes the stream only after onEnd returns, so draining waits for it.
      try {
        await originalConsumeStream();
      } catch {
        // A failed drain falls through to the failed finalization below.
      }
    }
    await finalizeHarnessStream();
    // onEnd sets finishObserved before it finalizes; when it did, the call
    // below only waits for that finalization.
    if (!finishObserved) {
      didFail = true;
      terminalError ??= new Error(
        "Model stream ended without a completion callback",
      );
      failureText ??= terminalError.message;
    }
    await finalizer.finalize(
      "failed",
      toolCallSummaries.size,
      Date.now() - runStartedAt,
      terminalError,
    );
  };

  /**
   * Wrap consumeStream so finalization fires in a finally block even when
   * streamText throws hard (e.g. network failure before any chunk arrives) and
   * onEnd / onError never run.
   */
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
      // consumeStream reads to the end or throws once the stream has errored;
      // either way the model is done.
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

/**
 * Records a turn that failed before runAgentLoop could open its root span, as
 * the failed task it is: one root span on the trace id the turn's log lines
 * already carry, so the task list shows it and "View trace" on those lines
 * finds it instead of "Trace not found".
 */
export function recordFailedTurn(
  session: Session,
  startedAt: number,
  error: unknown,
): void {
  const context = getObservabilityContext();
  const traceId = context?.traceId ?? mintTraceId();
  const scope = {
    accountId: session.accountId ?? "",
    project: session.projectSlug ?? "",
    stage: session.stageSlug ?? "",
    endpointId: session.endpointId ?? "",
    agentId: session.agentId ?? "",
    conversationKey: session.conversationKey,
  };
  const kind: ObservabilitySpanRow["kind"] = session.trigger ?? "task";
  const name = `agent.${kind}`;
  const message = redactSensitiveText(
    errorMessage(error),
    context?.secretValues,
  );
  const endTimeMs = Date.now();
  // Started under a span context that only carries the trace id, so the OTel
  // span lands on the trace the log lines name rather than on a fresh one.
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
  // Best-effort and off the turn's path: a NATS outage must not hold up the
  // failure's settlement.
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

// Tracing labels a run with this and its search matches on it. Only text parts
// count, and a tool continuation keeps the request that started the run.
export function latestUserText(messages: ModelMessage[]): string {
  const message = messages.findLast(
    (candidate): candidate is UserModelMessage => candidate.role === "user",
  );

  return message ? extractText(message.content).trim() : "";
}

/**
 * The joined system prompt the provider received, for the root and step spans.
 * The counts ride alongside because `serialize` truncates oversized payloads.
 */
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

// The SDK measures execute() directly, so it wins; the handler clock is only a
// fallback, and it overstates parallel calls by the model's own time.
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

/** The redacted, user-facing text for a run failure, used for replies, logs and lifecycle events. */
function errorMessage(error: unknown): string {
  const rawMessage = toErrorMessage(error);
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

/**
 * Drains queued steering into the turn context before a HarnessAgent turn
 * starts, and rebuilds the system prompt when any arrived.
 */
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

/**
 * The model messages of a steer, before or during a turn. Its attachments are
 * read back as the turn's history was, not left for the provider to fetch.
 */
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

/**
 * The history with the live environment after it. It rides on the person's
 * latest message when that comes last, so the model still reads one request,
 * and comes as its own message after a tool result. With a `breakpoint` the
 * end of the history, right before the environment, is a cache breakpoint.
 */
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

/**
 * The new turn an AI SDK Harness session receives. A tool continuation stays
 * assistant + tool as it is; a user turn carries the live environment.
 */
function harnessPromptMessages(
  messages: ModelMessage[],
  environment: string,
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
  const content = userMessages.flatMap((message) =>
    typeof message.content === "string"
      ? [{ type: "text" as const, text: message.content }]
      : message.content,
  );

  return withEnvironment(
    userMessages.length === 1
      ? userMessages
      : [{ role: "user", content: content }],
    environment,
  );
}

/**
 * Fails the run when its model goes silent: no first chunk of a model call
 * within MODEL_FIRST_CHUNK_TIMEOUT_MS, or no chunk within MODEL_CHUNK_TIMEOUT_MS
 * of the last. The clock stops while a tool call is open, so a long tool never
 * reads as a stalled model. A provider-executed call only stops it on a
 * harness, whose native tools (bash) are provider-executed; on streamText its
 * result streams back from the model itself. It reads its own copy of the stream, which covers
 * streamText and HarnessAgent alike: the SDK's `timeout.chunkMs` keeps ticking
 * through tool execution, and HarnessAgent ignores `timeout`.
 */
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
      // The model is done; onEnd may still be persisting.
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
      arm(
        MODEL_CALL_BOUNDARY_PART_TYPES.has(part.type) ? firstChunkMs : chunkMs,
      );
    }
  } catch {
    // The run's own reader reports a failed stream.
  } finally {
    clearTimeout(timer);
  }
}

/** One provider call warning as a single line, for the per-step warning log. */
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

/** A duration for log messages. */
function formatDuration(durationMs: number | undefined): string {
  return typeof durationMs === "number"
    ? `${durationMs}ms`
    : "unknown duration";
}

/** Token usage as one phrase for the step and invocation log messages. */
function formatUsageSummary(usage: LanguageModelUsage | undefined): string {
  const totals = usageTokenTotals(usage);

  return `${totals.inputTokens} in / ${totals.outputTokens} out / ${totals.totalTokens} total token(s)`;
}

/**
 * Publishes a span row to the dashboard's live trace stream over NATS. Best-effort:
 * the terminal span is tracked for shutdown, other callers ignore it.
 */
function publishSpan(row: ObservabilitySpanRow): Promise<void> {
  const connPromise = getSharedNatsConn();
  if (!connPromise) return Promise.resolve();

  const ctx = getObservabilityContext();
  // Skip traffic that cannot be resolved to a deployment. No dashboard trace
  // subscription exists for that scope; Tempo still receives the OTel span.
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
      // Create the durable stream up front so even the first span of a cold
      // container lands for replay; memoized, so this is ~free after the
      // first call. If it fails the live publish still reaches subscribers.
      await ensureObservabilityStream(conn).catch(() => {});
      conn.publish(subject, SPAN_ENCODER.encode(JSON.stringify(row)));
    })
    .catch(() => {
      // Best-effort: NATS hiccup must not affect the run.
    });
}

/** The text of an `error-text` tool output, so onToolExecutionEnd marks that call failed. */
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

/**
 * Fold an agent.started hook return into the turn context: `system` is appended
 * as a system message (also to ephemeralSystem so it survives prepareStep
 * refreshes), and `messages` replaces the conversation the model sees.
 */
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

/** Loose check that a hook's messages override entry looks like a model message. */
function isModelMessageShape(entry: unknown): boolean {
  return (
    isPlainObject(entry) &&
    typeof entry.role === "string" &&
    ["system", "user", "assistant", "tool"].includes(entry.role) &&
    entry.content !== undefined
  );
}

/**
 * Fold an agent.finished hook's { output } into the final response. On the
 * streaming (SSE) path the tokens are already sent, so this changes the
 * delivered/stored final result, not the already-streamed text.
 */
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

/** Every tool approval request across a finished run's steps, read by onEnd. */
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

/** The approval summary onEnd hands to hooks and `onApprovalRequired`. */
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

/** Merges an update into a tool call's summary, keyed by call id, as the loop's tool hooks fire. */
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

/** Tool names, per-tool counts and step-ordered calls for the finish and failure logs and events. */
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

/**
 * Puts the tool call before each approval request that lacks one, so the
 * persisted history can resume the call once it is approved.
 */
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

/** An approval request's tool call as a message part, for `withApprovalToolCalls`. */
function toToolCallPart(toolCall: ApprovalToolCall): ToolCallPart {
  return {
    type: "tool-call",
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    input: toolCall.input,
  };
}

/** The `errorDetails` of a failure log: name, message, status fields and a short stack. */
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
  // A provider's own failure payload has no stack and no shape we control, so
  // keep it whole. It is the only record of what the provider actually said.
  if (!(error instanceof Error)) {
    details.raw = errorObject;
  }

  return details;
}

// Trace attributes keep a media part's type and size, not its base64: a
// screenshot would fill the attribute with truncated noise. This covers the
// tool results and the user attachments in a step's messages.
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

// A tool's own output for its trace span, without media bytes.
function outputWithoutMediaBytes(output: unknown): unknown {
  const parsed = parseToolResultOutput(output);

  return parsed ? toolOutputWithoutMediaBytes(parsed) : output;
}

// One tool result with each image or file part's data replaced by its size.
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
