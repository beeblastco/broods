/**
 * Main Lambda handling logic for harness-processing.
 * Keep request orchestration, session setup, and response shaping here.
 */

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { ToolModelMessage } from "ai";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import { formatChannelErrorText } from "../_shared/channels.ts";
import { executeCommand } from "../_shared/commands.ts";
import { requireEnv } from "../_shared/env.ts";
import { jsonResponse } from "../_shared/http.ts";
import { logError, logInfo } from "../_shared/log.ts";
import type { LambdaInvocation, LambdaResponse } from "../_shared/runtime.ts";
import { publicConversationKeyFromScoped } from "../_shared/runtime-keys.ts";
import { fireWebhook, type WebhookConfig } from "../_shared/webhook.ts";
import { runAgentLoop, type ToolApprovalSummary } from "./harness.ts";
import {
  routeIncomingEvent,
  type AsyncDirectInboundEvent,
  type ChannelInboundEvent,
  type DirectInboundEvent,
  type StatusInboundEvent,
} from "./integrations.ts";
import { Session } from "./session.ts";
import {
  createPendingAsyncAgentResult,
  getAsyncAgentResult,
  markAsyncAgentResultAwaitingApproval,
  markAsyncAgentResultCompleted,
  markAsyncAgentResultFailed,
} from "./async-agent-result.ts";
import { SubagentCoordinator } from "./subagents.ts";
import { AsyncToolCoordinator } from "./async-tools.ts";

type AgentLoopStream = Awaited<ReturnType<typeof runAgentLoop>>;

const CONVERSATIONS_TABLE_NAME = requireEnv("CONVERSATIONS_TABLE_NAME");
const AGENT_PROCESSING_FAILED = "Agent processing failed";
const CHANNEL_APPROVAL_DENIAL_REASON = "Tool approval is only supported through the direct API.";
const LAMBDA_TIMEOUT_SAFETY_MS = 5 * 60 * 1000;
const DEFAULT_PARENT_WAIT_MS = 8 * 60 * 1000;
const textEncoder = new TextEncoder();
const lambda = new LambdaClient({ region: process.env.AWS_REGION });

interface AsyncWorkerInvocation {
  kind: "direct-api-async-worker";
  event: DirectInboundEvent;
}

interface DirectTurn {
  session: Session;
  turnContext: Awaited<ReturnType<Session["createTurnContext"]>>;
}

interface ParentContinuationResult {
  didFail: boolean;
  failureText: string | null;
  finalTexts: string[];
  approvals: ToolApprovalSummary[];
}

export async function handler(
  event: LambdaFunctionURLEvent | AsyncWorkerInvocation,
  context?: LambdaInvocation,
): Promise<LambdaResponse> {
  if (isAsyncWorkerInvocation(event)) {
    await handleAsyncWorkerRequest(event.event, context);
    return { statusCode: 204 };
  }

  return routeIncomingEvent(event, {
    handleDirectRequest: (directEvent) => handleDirectRequest(directEvent, context),
    handleAsyncRequest,
    handleStatusRequest,
    handleChannelRequest: (channelEvent) => handleChannelRequest(channelEvent, context),
  });
}

async function handleDirectRequest(event: DirectInboundEvent, context?: LambdaInvocation): Promise<LambdaResponse> {
  if (!hasRunnableDirectEvents(event)) {
    return emptySseResponse();
  }

  try {
    const turn = await prepareDirectTurn(event);
    if (!turn) {
      return emptySseResponse();
    }

    const { session, turnContext } = turn;
    if (!isRunnableModelInput(turnContext.messages.at(-1))) {
      return emptySseResponse();
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "text/event-stream" },
      body: createDirectContinuationSseBody(event, session, turnContext, context),
    };
  } catch (err) {
    logError("Direct request pre-processing failed", {
      eventId: event.eventId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function handleAsyncRequest(event: AsyncDirectInboundEvent): Promise<LambdaResponse> {
  if (!hasRunnableDirectEvents(event)) {
    await createPendingAsyncAgentResult({
      eventId: event.eventId,
      conversationKey: event.conversationKey,
    });
    await markAsyncAgentResultFailed({
      eventId: event.eventId,
      error: "Request must include at least one user event or tool approval response",
    });
    return acceptedAsyncResponse(event.statusUrl);
  }

  const created = await createPendingAsyncAgentResult({
    eventId: event.eventId,
    conversationKey: event.conversationKey,
  });

  if (created) {
    try {
      await invokeAsyncWorker(event);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start async worker";
      logError("Failed to invoke async worker", {
        eventId: event.eventId,
        error: message,
      });
      await settleAsyncFailure(event, message);
    }
  }

  return acceptedAsyncResponse(event.statusUrl);
}

async function handleStatusRequest(event: StatusInboundEvent): Promise<LambdaResponse> {
  const result = await getAsyncAgentResult(event.eventId);
  if (!result) {
    return jsonResponse(404, {
      eventId: event.publicEventId,
      status: "not_found",
    });
  }

  return jsonResponse(200, {
    eventId: event.publicEventId,
    conversationKey: eventPublicConversationKey(result.conversationKey, event.accountId, event.agentId),
    status: result.status,
    ...(result.response ? { response: result.response } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.approvals ? { approvals: result.approvals } : {}),
  });
}

async function handleAsyncWorkerRequest(event: DirectInboundEvent, context?: LambdaInvocation): Promise<void> {
  try {
    const turn = await prepareDirectTurn(event);
    if (!turn) {
      return;
    }

    const { session, turnContext } = turn;
    if (!isRunnableModelInput(turnContext.messages.at(-1))) {
      await settleAsyncFailure(event, "Request did not produce pending model input");
      return;
    }

    let didSettle = false;
    const result = await runAgentLoopUntilSubagentsIdle(session, turnContext, event.accountConfig, context, {
      onFinalText: async (text) => {
        didSettle = true;
        await markAsyncAgentResultCompleted({
          eventId: event.eventId,
          response: text,
        });
        await sendWebhook(event, {
          eventId: event.publicEventId,
          conversationKey: event.publicConversationKey,
          response: text,
          success: true,
        });
      },
      onErrorText: async (error) => {
        didSettle = true;
        await settleAsyncFailure(event, error);
      },
      onApprovalRequired: async (approvals) => {
        await markAsyncAgentResultAwaitingApproval({
          eventId: event.eventId,
          approvals,
        });
        didSettle = true;
        await sendWebhook(event, {
          eventId: event.publicEventId,
          conversationKey: event.publicConversationKey,
          status: "awaiting_approval",
          approvals,
          success: true,
        });
      },
    });

    if (result.didFail && !didSettle) {
      await settleAsyncFailure(event, result.failureText ?? AGENT_PROCESSING_FAILED);
    }
  } catch (err) {
    logError("Async direct request processing failed", {
      eventId: event.eventId,
      error: err instanceof Error ? err.message : String(err),
    });
    await settleAsyncFailure(event, err instanceof Error ? err.message : "Async request failed");
    throw err;
  }
}

async function prepareDirectTurn(event: DirectInboundEvent): Promise<DirectTurn | null> {
  const session = new Session(event.eventId, event.conversationKey, event.accountId, event.agentId, event.accountConfig);
  if (!(await claimSession(session))) {
    return null;
  }

  try {
    const ephemeralSystem = await session.appendIngressEvents(event.events);
    const turnContext = await session.createTurnContext(ephemeralSystem);
    return { session, turnContext };
  } catch (err) {
    await session.release().catch(() => { });
    throw err;
  }
}

async function handleChannelRequest(event: ChannelInboundEvent, context?: LambdaInvocation): Promise<void> {
  const session = new Session(event.eventId, event.conversationKey, event.accountId, event.agentId, event.accountConfig ?? {});
  if (!(await claimSession(session))) {
    return;
  }

  if (event.commandToken) {
    await executeCommand(event.commandToken, {
      conversationKey: event.conversationKey,
      conversationsTableName: CONVERSATIONS_TABLE_NAME,
      channel: event.channel,
    });
    return;
  }

  try {
    await session.appendIngressEvents(event.events);
  } catch (err) {
    logError("Channel request pre-processing failed", {
      eventId: session.eventId,
      conversationKey: session.conversationKey,
      error: err instanceof Error ? err.message : String(err),
    });
    await session.release().catch(() => { });
    throw err;
  }

  if (!(await session.acquireConversationLease())) {
    logInfo("Conversation already processing; event queued", {
      conversationKey: session.conversationKey,
      eventId: session.eventId,
    });
    return;
  }

  try {
    while (true) {
      const turnContext = await session.createTurnContext();
      if (!isRunnableModelInput(turnContext.messages.at(-1))) {
        return;
      }

      const result = await runAgentLoopUntilSubagentsIdle(session, turnContext, event.accountConfig ?? {}, context, {
        onFinalText: (text) => event.channel.sendText(text),
        onErrorText: (error) => event.channel.sendText(formatChannelErrorText(error)),
        onApprovalRequired: async (approvals) => {
          await session.persistModelMessages([createChannelApprovalDenial(approvals)]);
        },
      });

      if (result.didFail) {
        return;
      }
    }
  } finally {
    await session.releaseConversationLease().catch(() => { });
  }
}

async function claimSession(session: Session): Promise<boolean> {
  if (!(await session.claim())) {
    logInfo("Duplicate event skipped", { eventId: session.eventId });
    return false;
  }

  return true;
}

async function settleAsyncFailure(event: DirectInboundEvent, error: string): Promise<void> {
  await markAsyncAgentResultFailed({
    eventId: event.eventId,
    error,
  });
  await sendWebhook(event, {
    eventId: event.publicEventId,
    conversationKey: event.publicConversationKey,
    success: false,
    error,
  });
}

async function sendWebhook(
  event: { webhookConfig?: WebhookConfig },
  payload: unknown,
): Promise<void> {
  if (!event.webhookConfig) {
    return;
  }

  try {
    await fireWebhook(event.webhookConfig, payload);
  } catch (err) {
    logError("Webhook delivery failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function invokeAsyncWorker(event: DirectInboundEvent): Promise<void> {
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (!functionName) {
    throw new Error("Missing AWS_LAMBDA_FUNCTION_NAME for async worker invocation");
  }

  await lambda.send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: "Event",
    Payload: textEncoder.encode(JSON.stringify({
      kind: "direct-api-async-worker",
      event,
    } satisfies AsyncWorkerInvocation)),
  }));
}

function emptySseResponse(): LambdaResponse {
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/event-stream" },
    body: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
  };
}

function createChannelApprovalDenial(approvals: ToolApprovalSummary[]): ToolModelMessage {
  return {
    role: "tool",
    content: approvals.map((approval) => ({
      type: "tool-approval-response",
      approvalId: approval.approvalId,
      approved: false,
      reason: CHANNEL_APPROVAL_DENIAL_REASON,
    })),
  };
}

function acceptedAsyncResponse(statusUrl: string): LambdaResponse {
  return jsonResponse(202, { statusUrl });
}

function eventPublicConversationKey(conversationKey: string, accountId: string, agentId?: string): string {
  return publicConversationKeyFromScoped(conversationKey, accountId, agentId);
}

function isAsyncWorkerInvocation(event: unknown): event is AsyncWorkerInvocation {
  return Boolean(
    event &&
    typeof event === "object" &&
    (event as { kind?: unknown }).kind === "direct-api-async-worker",
  );
}

function hasRunnableDirectEvents(event: DirectInboundEvent): boolean {
  return event.events.some(isRunnableModelInput);
}

// A persisted tool result is history, not new model input. Only user turns and
// AI SDK approval responses should start or resume a model run.
function isRunnableModelInput(message: DirectInboundEvent["events"][number] | DirectTurn["turnContext"]["messages"][number] | undefined): boolean {
  return message?.role === "user" ||
    (message?.role === "tool" &&
      message.content.length > 0 &&
      message.content.every((part) => part.type === "tool-approval-response"));
}

function createDirectContinuationSseBody(
  event: DirectInboundEvent,
  session: Session,
  initialTurnContext: DirectTurn["turnContext"],
  context?: LambdaInvocation,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      const subagentCoordinator = new SubagentCoordinator(session, event.accountConfig, waitUntilMs(context));
      const asyncToolCoordinator = new AsyncToolCoordinator(session, waitUntilMs(context));

      try {
        const result = await runParentContinuationLoop({
          session: session,
          subagentCoordinator: subagentCoordinator,
          asyncToolCoordinator: asyncToolCoordinator,
          initialTurnContext: initialTurnContext,
          accountConfig: event.accountConfig,
          consumeStream: (stream) => pipeAgentSseStream(stream, controller),
          onLoopErrorText: (error) => sendWebhook(event, {
            eventId: event.publicEventId,
            conversationKey: event.publicConversationKey,
            success: false,
            error,
          }),
          onApprovalRequired: (approvals) => sendWebhook(event, {
            eventId: event.publicEventId,
            conversationKey: event.publicConversationKey,
            status: "awaiting_approval",
            approvals,
            success: true,
          }),
          onHeartbeat: (pendingCount) => enqueueSseComment(controller, `waiting for async work pending=${pendingCount}`),
        });

        if (result.finalTexts.length > 0) {
          await sendWebhook(event, {
            eventId: event.publicEventId,
            conversationKey: event.publicConversationKey,
            response: result.finalTexts.join("\n\n"),
            success: true,
          });
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logError("Direct continuation stream failed", {
          eventId: event.eventId,
          error,
        });
        controller.enqueue(textEncoder.encode(`data: ${JSON.stringify({ type: "error", error })}\n\n`));
        await sendWebhook(event, {
          eventId: event.publicEventId,
          conversationKey: event.publicConversationKey,
          success: false,
          error,
        });
      } finally {
        controller.close();
      }
    },
  });
}

async function runAgentLoopUntilSubagentsIdle(
  session: Session,
  initialTurnContext: DirectTurn["turnContext"],
  accountConfig: DirectInboundEvent["accountConfig"],
  context: LambdaInvocation | undefined,
  reply: {
    onFinalText(text: string): Promise<void>;
    onErrorText(error: string): Promise<void>;
    onApprovalRequired?(approvals: ToolApprovalSummary[]): Promise<void>;
  },
): Promise<{ didFail: boolean; failureText: string | null }> {
  const subagentCoordinator = new SubagentCoordinator(session, accountConfig, waitUntilMs(context));
  const asyncToolCoordinator = new AsyncToolCoordinator(session, waitUntilMs(context));
  const result = await runParentContinuationLoop({
    session: session,
    subagentCoordinator: subagentCoordinator,
    asyncToolCoordinator: asyncToolCoordinator,
    initialTurnContext: initialTurnContext,
    accountConfig: accountConfig,
    consumeStream: async (stream) => {
      await stream.consumeStream();
    },
  });

  if (result.approvals.length > 0) {
    await reply.onApprovalRequired?.(result.approvals);
    return { didFail: false, failureText: null };
  }

  if (result.didFail) {
    await reply.onErrorText(result.failureText ?? AGENT_PROCESSING_FAILED);
    return { didFail: true, failureText: result.failureText };
  }

  if (result.finalTexts.length > 0) {
    await reply.onFinalText(result.finalTexts.join("\n\n"));
  }

  return { didFail: false, failureText: null };
}

async function runParentContinuationLoop(options: {
  session: Session;
  subagentCoordinator: SubagentCoordinator;
  asyncToolCoordinator: AsyncToolCoordinator;
  initialTurnContext: DirectTurn["turnContext"];
  accountConfig: DirectInboundEvent["accountConfig"];
  consumeStream(stream: AgentLoopStream): Promise<void>;
  onLoopErrorText?(error: string): Promise<void>;
  onApprovalRequired?(approvals: ToolApprovalSummary[]): Promise<void>;
  onHeartbeat?(pendingCount: number): void;
}): Promise<ParentContinuationResult> {
  let turnContext = options.initialTurnContext;
  const finalTexts: string[] = [];

  while (true) {
    let loopFinalText = "";
    let approvals: ToolApprovalSummary[] = [];
    const stream = await runAgentLoop(options.session, turnContext, options.accountConfig, {
      onFinalText: async (text) => {
        loopFinalText = text.trim();
      },
      onErrorText: async (error) => {
        await options.onLoopErrorText?.(error);
      },
      onApprovalRequired: async (approvalSummaries) => {
        approvals = approvalSummaries;
        await options.onApprovalRequired?.(approvalSummaries);
      },
    }, {
      dispatchSubagents: options.subagentCoordinator.dispatch,
      dispatchAsyncTools: options.asyncToolCoordinator.dispatch,
    });

    await options.consumeStream(stream);
    if (loopFinalText) {
      finalTexts.push(loopFinalText);
    }
    if (approvals.length > 0) {
      return { didFail: false, failureText: null, finalTexts, approvals };
    }
    if (stream.didFail()) {
      return {
        didFail: true,
        failureText: stream.failureText(),
        finalTexts,
        approvals: [],
      };
    }

    // Wait for any injected subagents or async tools to complete.
    const injected = await waitAndDrainAsyncWork(options.subagentCoordinator, options.asyncToolCoordinator, {
      onHeartbeat: options.onHeartbeat,
    });
    if (injected === 0) {
      return { didFail: false, failureText: null, finalTexts, approvals: [] };
    }

    turnContext = await options.session.createTurnContext();
    if (!isRunnableModelInput(turnContext.messages.at(-1))) {
      return { didFail: false, failureText: null, finalTexts, approvals: [] };
    }
  }
}

/**
 * Bridges one completed parent model pass to the next continuation pass.
 *
 * After the parent stream ends, subagent and async-tool results may already be
 * queued, still be running, or be absent. This helper waits for outstanding
 * work, emits SSE heartbeats while waiting, and injects parent-visible
 * completions plus timeout notices near the Lambda deadline.
 */
async function waitAndDrainAsyncWork(
  subagentCoordinator: SubagentCoordinator,
  asyncToolCoordinator: AsyncToolCoordinator,
  options: { onHeartbeat?: (pendingCount: number) => void } = {},
): Promise<number> {
  if (subagentCoordinator.pendingCount === 0 && asyncToolCoordinator.pendingCount === 0) {
    const [subagentCount, asyncToolCount] = await Promise.all([
      subagentCoordinator.drainCompletionsToParent(),
      asyncToolCoordinator.drainCompletionsToParent(),
    ]);
    return subagentCount + asyncToolCount;
  }

  const [subagentStatus, asyncToolStatus] = await Promise.all([
    subagentCoordinator.waitForIdle({
      onHeartbeat: () => options.onHeartbeat?.(subagentCoordinator.pendingCount + asyncToolCoordinator.pendingCount),
    }),
    asyncToolCoordinator.waitForIdle({
      onHeartbeat: () => options.onHeartbeat?.(subagentCoordinator.pendingCount + asyncToolCoordinator.pendingCount),
    }),
  ]);

  if (subagentStatus === "idle" && asyncToolStatus === "idle") {
    const [subagentCount, asyncToolCount] = await Promise.all([
      subagentCoordinator.drainCompletionsToParent(),
      asyncToolCoordinator.drainCompletionsToParent(),
    ]);
    return subagentCount + asyncToolCount;
  }

  const [subagentCount, asyncToolCount] = await Promise.all([
    subagentStatus === "idle"
      ? subagentCoordinator.drainCompletionsToParent()
      : subagentCoordinator.drainCompletionsAndTimeoutsToParent(),
    asyncToolStatus === "idle"
      ? asyncToolCoordinator.drainCompletionsToParent()
      : asyncToolCoordinator.drainCompletionsAndTimeoutsToParent(),
  ]);
  return subagentCount + asyncToolCount;
}

async function pipeAgentSseStream(
  stream: AgentLoopStream,
  controller: ReadableStreamDefaultController<Uint8Array>,
): Promise<void> {
  let emittedErrorChunk = false;
  const reader = stream.fullStream.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (isErrorStreamChunk(value)) {
      emittedErrorChunk = true;
    }
    controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(value)}\n\n`));
  }

  const failureText = stream.failureText();
  if (failureText && !emittedErrorChunk) {
    controller.enqueue(textEncoder.encode(`data: ${JSON.stringify({
      type: "error",
      error: failureText,
    })}\n\n`));
  }
}

function enqueueSseComment(
  controller: ReadableStreamDefaultController<Uint8Array>,
  comment: string,
): void {
  controller.enqueue(textEncoder.encode(`: ${comment}\n\n`));
}

function waitUntilMs(context: LambdaInvocation | undefined): number {
  if (context?.deadlineMs && Number.isFinite(context.deadlineMs)) {
    return Math.max(Date.now(), context.deadlineMs - LAMBDA_TIMEOUT_SAFETY_MS);
  }

  return Date.now() + DEFAULT_PARENT_WAIT_MS;
}

function isErrorStreamChunk(chunk: unknown): boolean {
  return Boolean(
    chunk &&
    typeof chunk === "object" &&
    (chunk as { type?: unknown }).type === "error",
  );
}
