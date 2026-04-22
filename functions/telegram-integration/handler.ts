// Telegram webhook handler: authenticate, run commands, call the streaming harness URL, and send the final reply.
import type { UserContent } from "ai";
import type { ChannelAdapter } from "../_shared/channels.ts";
import { extractText } from "../_shared/channels.ts";
import { executeCommand, parseCommand } from "../_shared/commands.ts";
import { requireEnv } from "../_shared/env.ts";
import { logError, logInfo } from "../_shared/log.ts";
import { createTelegramChannel } from "../_shared/telegram-channel.ts";

const HARNESS_PROCESSING_URL = requireEnv("HARNESS_PROCESSING_URL");
const CONVERSATIONS_TABLE_NAME = requireEnv("CONVERSATIONS_TABLE_NAME");

function parseAllowedChatIds(raw: string): Set<number> {
  const ids = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  if (ids.length === 0) throw new Error("ALLOWED_CHAT_IDS contains no valid numeric IDs");
  return new Set(ids);
}

const channels: ChannelAdapter[] = [
  createTelegramChannel(
    requireEnv("TELEGRAM_BOT_TOKEN"),
    requireEnv("TELEGRAM_WEBHOOK_SECRET"),
    parseAllowedChatIds(requireEnv("ALLOWED_CHAT_IDS")),
  ),
];

interface LambdaUrlEvent {
  requestContext: {
    http: { method: string; path: string };
  };
  headers: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}

interface LambdaUrlResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

function ok(data: Record<string, unknown> = {}): LambdaUrlResponse {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, ...data }),
  };
}

export async function handler(event: LambdaUrlEvent): Promise<LambdaUrlResponse> {
  const method = event.requestContext.http.method;

  if (method === "GET") {
    return ok({ service: "filthy-panty" });
  }

  if (method !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const body = event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString("utf-8")
      : (event.body ?? "");

    const adapter = channels.find((ch) => ch.authenticate(event.headers, body));
    if (!adapter) {
      return { statusCode: 401, body: "Unauthorized" };
    }

    const msg = adapter.parse(body);
    if (!msg) {
      return ok({ skipped: "no_actionable_message" });
    }

    const channel = adapter.actions(msg);
    const command = parseCommand(extractText(msg.content));
    if (command) {
      await executeCommand(command, {
        conversationKey: msg.conversationKey,
        conversationsTableName: CONVERSATIONS_TABLE_NAME,
        channel,
      });
      return ok({ command });
    }

    channel.sendTyping().catch(() => { });
    channel.reactToMessage().catch(() => { });

    await invokeHarnessProcessing(
      {
        eventId: msg.eventId,
        conversationKey: msg.conversationKey,
        content: msg.content,
      },
      channel,
    );

    logInfo("Harness processing complete", {
      channel: msg.channelName,
      eventId: msg.eventId,
      conversationKey: msg.conversationKey,
    });
    return ok();
  } catch (err) {
    logError("Failed to process inbound event", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { statusCode: 500, body: "Internal Server Error" };
  }
}

async function invokeHarnessProcessing(
  payload: {
    eventId: string;
    conversationKey: string;
    content: UserContent;
  },
  channel: import("../_shared/channels.ts").ChannelActions,
): Promise<void> {
  const response = await fetch(HARNESS_PROCESSING_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Harness processing returned HTTP ${response.status}: ${text}`);
  }

  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let replyText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.replace(/^data:\s*/, "").trim();
      if (!trimmed) {
        continue;
      }

      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.type === "text-delta") {
          const textDelta = typeof parsed.text === "string"
            ? parsed.text
            : (typeof parsed.delta === "string" ? parsed.delta : "");
          replyText += textDelta;
        }
      } catch {}
    }
  }

  if (replyText.trim()) {
    await channel.sendText(replyText.trim());
  }
}
