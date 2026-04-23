/**
 * Main Lambda handling logic for harness-processing.
 * Keep request orchestration, session setup, and response shaping here.
 */

import type { ModelMessage, UserContent } from "ai";
import { executeCommand } from "../_shared/commands.ts";
import { requireEnv } from "../_shared/env.ts";
import { logError, logInfo } from "../_shared/log.ts";
import type { LambdaResponse } from "../_shared/runtime.ts";
import { runAgentLoop } from "./harness.ts";
import {
  routeIncomingEvent,
  type ChannelInboundEvent,
  type HandlerEvent,
  type InboundEvent,
} from "./integrations.ts";
import { createSession } from "./session.ts";
import { emptyStream, sseEvent } from "./utils.ts";

const CONVERSATIONS_TABLE_NAME = requireEnv("CONVERSATIONS_TABLE_NAME");

export async function handler(event: HandlerEvent): Promise<LambdaResponse> {
  return routeIncomingEvent(event, {
    handleDirectRequest,
    handleChannelRequest,
  });
}

async function handleDirectRequest(event: InboundEvent): Promise<LambdaResponse> {
  const session = createSession(event.eventId, event.conversationKey);
  if (!(await claimSession(session))) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/event-stream" },
      body: emptyStream(),
    };
  }

  const history = await loadAndPersistUserMessage(session, event.content);
  const stream = runAgentLoop(session, event.content, history);
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/event-stream" },
    body: stream.fullStream.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(sseEvent(chunk as Record<string, unknown>));
      },
    })),
  };
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

  const history = await loadAndPersistUserMessage(session, event.content);
  const stream = runAgentLoop(session, event.content, history, {
    onFinalText: (text) => event.channel.sendText(text),
    onErrorText: () => event.channel.sendText("Something went wrong. Please try again."),
  });

  await stream.consumeStream();
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

async function loadAndPersistUserMessage(
  session: ReturnType<typeof createSession>,
  content: UserContent,
): Promise<ModelMessage[]> {
  try {
    const history = await session.loadHistory();
    await session.persistUserMessage(content);
    return history;
  } catch (err) {
    logError("Pre-processing failed", {
      eventId: session.eventId,
      error: err instanceof Error ? err.message : String(err),
    });
    await session.release().catch(() => { });
    throw err;
  }
}
