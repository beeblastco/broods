/**
 * Main Lambda handling logic for harness-processing.
 * Keep request orchestration, session setup, and response shaping here.
 */

import { executeCommand } from "../_shared/commands.ts";
import { requireEnv } from "../_shared/env.ts";
import { logError, logInfo } from "../_shared/log.ts";
import type { LambdaResponse } from "../_shared/runtime.ts";
import { runAgentLoop } from "./harness.ts";
import {
  routeIncomingEvent,
  type ChannelInboundEvent,
  type DirectInboundEvent,
  type HandlerEvent,
} from "./integrations.ts";
import { createSession } from "./session.ts";

const CONVERSATIONS_TABLE_NAME = requireEnv("CONVERSATIONS_TABLE_NAME");
const textEncoder = new TextEncoder();

export async function handler(event: HandlerEvent): Promise<LambdaResponse> {
  return routeIncomingEvent(event, {
    handleDirectRequest,
    handleChannelRequest,
  });
}

async function handleDirectRequest(event: DirectInboundEvent): Promise<LambdaResponse> {
  const session = createSession(event.eventId, event.conversationKey);
  if (!(await claimSession(session))) {
    return emptySseResponse();
  }

  try {
    const ephemeralSystem = await session.appendIngressEvents(event.events);
    if (!event.events.some((ingressEvent) => ingressEvent.role === "user")) {
      return emptySseResponse();
    }

    const turnContext = await session.createTurnContext(ephemeralSystem);
    if (!turnContext.hasPendingUserMessage) {
      return emptySseResponse();
    }

    const stream = await runAgentLoop(session, turnContext);
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/event-stream" },
      body: stream.fullStream.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        },
      })),
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

async function handleChannelRequest(event: ChannelInboundEvent): Promise<void> {
  const session = createSession(event.eventId, event.conversationKey);
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

      const stream = await runAgentLoop(session, turnContext, {
        onFinalText: (text) => event.channel.sendText(text),
        onErrorText: () => event.channel.sendText("Something went wrong. Please try again."),
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
