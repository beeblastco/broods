/**
 * Thin communication-channel integration layer for harness-processing.
 * Keep channel integration and message lifecycle handling here.
 */

import type { UserContent } from "ai";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import type { ChannelActions } from "../_shared/channels.ts";
import { extractText } from "../_shared/channels.ts";
import { executeCommand, parseCommand } from "../_shared/commands.ts";
import { requireEnv } from "../_shared/env.ts";
import { logError } from "../_shared/log.ts";
import { createTelegramChannel } from "../_shared/telegram-channel.ts";
import { emptyStream, sseEvent } from "./utils.ts";

const CONVERSATIONS_TABLE_NAME = requireEnv("CONVERSATIONS_TABLE_NAME");

const telegramChannel = createTelegramChannel(
  requireEnv("TELEGRAM_BOT_TOKEN"),
  requireEnv("TELEGRAM_WEBHOOK_SECRET"),
  parseAllowedChatIds(requireEnv("ALLOWED_CHAT_IDS")),
  requireEnv("TELEGRAM_REACTION_EMOJI"),
);

export interface InboundEvent {
  eventId: string;
  conversationKey: string;
  content: UserContent;
}

export type HandlerEvent = InboundEvent | LambdaFunctionURLEvent;

export interface TelegramInboundEvent extends InboundEvent {
  channel: ChannelActions;
}

interface IntegrationHandlers {
  handleDirectRequest(event: InboundEvent): Promise<ReadableStream<Uint8Array>>;
  handleTelegramRequest(event: TelegramInboundEvent): Promise<void>;
}

export async function routeIncomingEvent(
  event: HandlerEvent,
  handlers: IntegrationHandlers,
): Promise<ReadableStream<Uint8Array>> {
  if (!isLambdaUrlEvent(event)) {
    return handlers.handleDirectRequest(event);
  }

  return handleLambdaUrlEvent(event, handlers);
}

async function handleLambdaUrlEvent(
  event: LambdaFunctionURLEvent,
  handlers: IntegrationHandlers,
): Promise<ReadableStream<Uint8Array>> {
  const method = event.requestContext.http.method;

  if (method === "GET" || event.rawPath === "/health") {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(sseEvent({ service: "filthy-panty", status: "ok" }));
        controller.close();
      },
    });
  }

  if (method !== "POST") {
    return emptyStream();
  }

  const headers = normalizeHeaders(event.headers);
  const bodyText = decodeBody(event.body, event.isBase64Encoded);

  if (isTelegramWebhook(headers, bodyText)) {
    return handleTelegramWebhook(headers, bodyText, handlers);
  }

  const payload = parseDirectPayload(bodyText);
  return handlers.handleDirectRequest(payload);
}

async function handleTelegramWebhook(
  headers: Record<string, string>,
  bodyText: string,
  handlers: IntegrationHandlers,
): Promise<ReadableStream<Uint8Array>> {
  try {
    if (!telegramChannel.authenticate(headers, bodyText)) {
      return emptyStream();
    }

    const msg = telegramChannel.parse(bodyText);
    if (!msg) {
      return emptyStream();
    }

    const channel = telegramChannel.actions(msg);
    const command = parseCommand(extractText(msg.content));
    if (command) {
      await executeCommand(command, {
        conversationKey: msg.conversationKey,
        conversationsTableName: CONVERSATIONS_TABLE_NAME,
        channel,
      });
      return emptyStream();
    }

    channel.sendTyping().catch(() => { });
    channel.reactToMessage().catch(() => { });

    await handlers.handleTelegramRequest({
      eventId: msg.eventId,
      conversationKey: msg.conversationKey,
      content: msg.content,
      channel,
    });
  } catch (err) {
    logError("Failed to process Telegram webhook", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return emptyStream();
}

function normalizeHeaders(
  headers: Record<string, string | undefined>,
): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized[key.toLowerCase()] = value;
    }
  }

  return normalized;
}

function decodeBody(body: string | undefined, isBase64Encoded?: boolean): string {
  const raw = body ?? "";
  return isBase64Encoded ? Buffer.from(raw, "base64").toString("utf-8") : raw;
}

function isLambdaUrlEvent(event: HandlerEvent): event is LambdaFunctionURLEvent {
  return typeof event === "object" && event !== null && "version" in event;
}

function isTelegramWebhook(headers: Record<string, string>, bodyText: string): boolean {
  if ("x-telegram-bot-api-secret-token" in headers) {
    return true;
  }

  try {
    const parsed = JSON.parse(bodyText);
    return typeof parsed.update_id === "number"
      && (typeof parsed.message === "object" || typeof parsed.edited_message === "object");
  } catch {
    return false;
  }
}

function parseDirectPayload(bodyText: string): InboundEvent {
  let parsed: unknown;

  try {
    parsed = JSON.parse(bodyText);
  } catch (err) {
    throw new Error(`Invalid request JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).eventId !== "string" ||
    typeof (parsed as Record<string, unknown>).conversationKey !== "string" ||
    !("content" in (parsed as Record<string, unknown>))
  ) {
    throw new Error("Request body must include eventId, conversationKey, and content");
  }

  return parsed as InboundEvent;
}

function parseAllowedChatIds(raw: string): Set<number> {
  const ids = raw
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));

  if (ids.length === 0) {
    throw new Error("ALLOWED_CHAT_IDS contains no valid numeric IDs");
  }

  return new Set(ids);
}
