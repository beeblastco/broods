/**
 * Main Lambda handling logic for harness-processing.
 * Keep request orchestration, session setup, and response shaping here.
 */

import type { ModelMessage, UserContent } from "ai";
import { logError, logInfo } from "../_shared/log.ts";
import { runAgentLoop } from "./harness.ts";
import {
  routeIncomingEvent,
  type HandlerEvent,
  type InboundEvent,
  type TelegramInboundEvent,
} from "./integrations.ts";
import { createSession } from "./session.ts";
import { emptyStream, sseEvent } from "./utils.ts";

export async function handler(event: HandlerEvent): Promise<ReadableStream<Uint8Array>> {
  return routeIncomingEvent(event, {
    handleDirectRequest,
    handleTelegramRequest,
  });
}

async function handleDirectRequest(event: InboundEvent): Promise<ReadableStream<Uint8Array>> {
  const { eventId, conversationKey, content } = event;
  const session = createSession(eventId, conversationKey);
  const history = await loadAndPersistUserMessage(session, content);
  if (history == null) {
    return emptyStream();
  }

  const result = runAgentLoop(session, content, history);
  return result.fullStream.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(sseEvent(chunk as Record<string, unknown>));
    },
  }));
}

async function handleTelegramRequest(event: TelegramInboundEvent): Promise<void> {
  const session = createSession(event.eventId, event.conversationKey);
  const history = await loadAndPersistUserMessage(session, event.content);
  if (history == null) {
    return;
  }

  const result = runAgentLoop(session, event.content, history, {
    onFinalText: (text) => event.channel.sendText(text),
    onErrorText: () => event.channel.sendText("Something went wrong. Please try again."),
  });

  await result.consumeStream();
}

async function loadAndPersistUserMessage(
  session: ReturnType<typeof createSession>,
  content: UserContent,
): Promise<ModelMessage[] | null> {
  if (!(await session.claim())) {
    logInfo("Duplicate event skipped", { eventId: session.eventId });
    return null;
  }

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
