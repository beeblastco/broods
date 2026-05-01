/**
 * Main Lambda handling logic for harness-processing.
 * Keep request orchestration, session setup, and response shaping here.
 */

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import { formatChannelErrorText } from "../_shared/channels.ts";
import { executeCommand } from "../_shared/commands.ts";
import { requireEnv } from "../_shared/env.ts";
import { jsonResponse } from "../_shared/http.ts";
import { logError, logInfo } from "../_shared/log.ts";
import type { LambdaResponse } from "../_shared/runtime.ts";
import { fireWebhook, type WebhookConfig } from "../_shared/webhook.ts";
import { runAgentLoop } from "./harness.ts";
import {
  routeIncomingEvent,
  type AsyncDirectInboundEvent,
  type ChannelInboundEvent,
  type DirectInboundEvent,
  type StatusInboundEvent,
} from "./integrations.ts";
import { createSession } from "./session.ts";
import {
  createPendingAsyncResult,
  getAsyncResult,
  markAsyncResultCompleted,
  markAsyncResultFailed,
} from "./status.ts";

type AgentLoopStream = Awaited<ReturnType<typeof runAgentLoop>>;

const CONVERSATIONS_TABLE_NAME = requireEnv("CONVERSATIONS_TABLE_NAME");
const AGENT_PROCESSING_FAILED = "Agent processing failed";
const textEncoder = new TextEncoder();
const lambda = new LambdaClient({ region: process.env.AWS_REGION });

interface AsyncWorkerInvocation {
  kind: "direct-api-async-worker";
  event: DirectInboundEvent;
}

export async function handler(event: LambdaFunctionURLEvent | AsyncWorkerInvocation): Promise<LambdaResponse> {
  if (isAsyncWorkerInvocation(event)) {
    await handleAsyncWorkerRequest(event.event);
    return { statusCode: 204 };
  }

  return routeIncomingEvent(event, {
    handleDirectRequest,
    handleAsyncRequest,
    handleStatusRequest,
    handleChannelRequest,
  });
}

async function handleDirectRequest(event: DirectInboundEvent): Promise<LambdaResponse> {
  if (!event.events.some((ingressEvent) => ingressEvent.role === "user")) {
    return emptySseResponse();
  }

  const session = createSession(event.eventId, event.conversationKey, event.accountId, event.accountConfig);
  if (!(await claimSession(session))) {
    return emptySseResponse();
  }

  try {
    const ephemeralSystem = await session.appendIngressEvents(event.events);
    const turnContext = await session.createTurnContext(ephemeralSystem);
    if (!turnContext.hasPendingUserMessage) {
      return emptySseResponse();
    }

    const stream = await runAgentLoop(session, turnContext, event.accountConfig, directReplyHooks(event));
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/event-stream" },
      body: createDirectSseBody(stream),
    };
  } catch (err) {
    logError("Direct request pre-processing failed", {
      eventId: session.eventId,
      error: err instanceof Error ? err.message : String(err),
    });
    await session.release().catch(() => { });
    throw err;
  }
}

async function handleAsyncRequest(event: AsyncDirectInboundEvent): Promise<LambdaResponse> {
  if (!event.events.some((ingressEvent) => ingressEvent.role === "user")) {
    await createPendingAsyncResult({
      eventId: event.eventId,
      conversationKey: event.conversationKey,
    });
    await markAsyncResultFailed({
      eventId: event.eventId,
      error: "Request must include at least one user event",
    });
    return acceptedAsyncResponse(event.statusUrl);
  }

  const created = await createPendingAsyncResult({
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
  const result = await getAsyncResult(event.eventId);
  if (!result) {
    return jsonResponse(404, {
      eventId: event.publicEventId,
      status: "not_found",
    });
  }

  return jsonResponse(200, {
    eventId: event.publicEventId,
    conversationKey: eventPublicConversationKey(result.conversationKey, event.accountId),
    status: result.status,
    ...(result.response ? { response: result.response } : {}),
    ...(result.error ? { error: result.error } : {}),
  });
}

async function handleAsyncWorkerRequest(event: DirectInboundEvent): Promise<void> {
  const session = createSession(event.eventId, event.conversationKey, event.accountId, event.accountConfig);
  if (!(await claimSession(session))) {
    return;
  }

  try {
    const ephemeralSystem = await session.appendIngressEvents(event.events);
    const turnContext = await session.createTurnContext(ephemeralSystem);
    if (!turnContext.hasPendingUserMessage) {
      await settleAsyncFailure(event, "Request did not produce a pending user message");
      return;
    }

    let didSettle = false;
    const stream = await runAgentLoop(session, turnContext, event.accountConfig, {
      onFinalText: async (text) => {
        didSettle = true;
        await markAsyncResultCompleted({
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
    });

    await stream.consumeStream();
    if (stream.didFail() && !didSettle) {
      await settleAsyncFailure(event, stream.failureText() ?? AGENT_PROCESSING_FAILED);
    }
  } catch (err) {
    logError("Async direct request processing failed", {
      eventId: event.eventId,
      error: err instanceof Error ? err.message : String(err),
    });
    await settleAsyncFailure(event, err instanceof Error ? err.message : "Async request failed");
    await session.release().catch(() => { });
    throw err;
  }
}

async function handleChannelRequest(event: ChannelInboundEvent): Promise<void> {
  const session = createSession(event.eventId, event.conversationKey, event.accountId, event.accountConfig ?? {});
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
      if (!turnContext.hasPendingUserMessage) {
        return;
      }

      const stream = await runAgentLoop(session, turnContext, event.accountConfig ?? {}, {
        onFinalText: (text) => event.channel.sendText(text),
        onErrorText: (error) => event.channel.sendText(formatChannelErrorText(error)),
      });

      await stream.consumeStream();
      if (stream.didFail()) {
        return;
      }
    }
  } finally {
    await session.releaseConversationLease().catch(() => { });
  }
}

async function claimSession(
  session: ReturnType<typeof createSession>,
): Promise<boolean> {
  if (!(await session.claim())) {
    logInfo("Duplicate event skipped", { eventId: session.eventId });
    return false;
  }

  return true;
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

function directReplyHooks(event: DirectInboundEvent) {
  return event.webhookConfig
    ? {
      onFinalText: async (text: string) => sendWebhook(event, {
        eventId: event.publicEventId,
        conversationKey: event.publicConversationKey,
        response: text,
        success: true,
      }),
      onErrorText: async (error: string) => sendWebhook(event, {
        eventId: event.publicEventId,
        conversationKey: event.publicConversationKey,
        success: false,
        error,
      }),
    }
    : undefined;
}

async function settleAsyncFailure(event: DirectInboundEvent, error: string): Promise<void> {
  await markAsyncResultFailed({
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

function acceptedAsyncResponse(statusUrl: string): LambdaResponse {
  return jsonResponse(202, { statusUrl });
}

function eventPublicConversationKey(conversationKey: string, accountId: string): string {
  const accountPrefix = `acct:${accountId}:`;
  const unscoped = conversationKey.startsWith(accountPrefix)
    ? conversationKey.slice(accountPrefix.length)
    : conversationKey;

  return unscoped.replace(/^api:/, "");
}

function isAsyncWorkerInvocation(event: unknown): event is AsyncWorkerInvocation {
  return Boolean(
    event &&
    typeof event === "object" &&
    (event as { kind?: unknown }).kind === "direct-api-async-worker",
  );
}

function createDirectSseBody(stream: AgentLoopStream): ReadableStream<Uint8Array> {
  let emittedErrorChunk = false;

  return stream.fullStream.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      if (isErrorStreamChunk(chunk)) {
        emittedErrorChunk = true;
      }

      controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    },
    flush(controller) {
      const failureText = stream.failureText();
      if (!failureText || emittedErrorChunk) {
        return;
      }

      controller.enqueue(textEncoder.encode(`data: ${JSON.stringify({
        type: "error",
        error: failureText,
      })}\n\n`));
    },
  }));
}

function isErrorStreamChunk(chunk: unknown): boolean {
  return Boolean(
    chunk &&
    typeof chunk === "object" &&
    (chunk as { type?: unknown }).type === "error",
  );
}
