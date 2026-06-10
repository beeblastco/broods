/**
 * Zalo channel adapter tests.
 * Cover webhook auth, allow-list filtering, and text message normalization here.
 */

import { describe, expect, it } from "bun:test";
import { createZaloChannel } from "../functions/_shared/zalo-channel.ts";

describe("zalo channel adapter", () => {
  it("authenticates matching webhook secrets and rejects mismatches", () => {
    const adapter = createZaloChannel("bot-token", "zalo-secret", new Set(["user-1"]));

    expect(adapter.authenticate(createZaloRequest(validUpdate(), {
      "x-bot-api-secret-token": "zalo-secret",
    }))).toBe(true);
    expect(adapter.authenticate(createZaloRequest(validUpdate(), {
      "x-bot-api-secret-token": "wrong-secret",
    }))).toBe(false);
    expect(adapter.authenticate(createZaloRequest(validUpdate(), {}))).toBe(false);
  });

  it("normalizes text webhook events into direct conversations", async () => {
    const adapter = createZaloChannel("bot-token", "zalo-secret", new Set(["user-1"]));
    const parsed = await adapter.parse(createZaloRequest(validUpdate({
      text: "  hello zalo  ",
    })));

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected Zalo message event to be accepted");
    }

    expect(parsed.ack).toEqual({ statusCode: 200, body: "ok" });
    expect(parsed.message).toEqual({
      eventId: "zalo:message.text.received:chat-1:user-1:message-1",
      conversationKey: "zalo:chat-1",
      channelName: "zalo",
      content: "hello zalo",
      source: {
        chatId: "chat-1",
        chatType: "PRIVATE",
        messageId: "message-1",
        senderId: "user-1",
        senderName: "Ada",
        eventName: "message.text.received",
        date: 1713916800,
      },
    });
  });

  it("accepts wrapped Zalo API webhook envelopes", async () => {
    const adapter = createZaloChannel("bot-token", "zalo-secret", new Set(["user-1"]));
    const parsed = await adapter.parse(createZaloRequest({
      ok: true,
      result: validUpdate({ text: "wrapped" }),
    }));

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected wrapped Zalo event to be accepted");
    }
    expect(parsed.message.content).toBe("wrapped");
  });

  it("ignores unsupported events, groups, blank text, bot messages, and unknown senders", async () => {
    const adapter = createZaloChannel("bot-token", "zalo-secret", new Set(["user-1"]));

    expect(await adapter.parse(createZaloRequest(validUpdate({ eventName: "message.image.received" })))).toEqual({
      kind: "ignore",
    });
    expect(await adapter.parse(createZaloRequest(validUpdate({ chatType: "GROUP" })))).toEqual({ kind: "ignore" });
    expect(await adapter.parse(createZaloRequest(validUpdate({ text: "   " })))).toEqual({ kind: "ignore" });
    expect(await adapter.parse(createZaloRequest(validUpdate({ isBot: true })))).toEqual({ kind: "ignore" });
    expect(await adapter.parse(createZaloRequest(validUpdate({ senderId: "user-2" })))).toEqual({ kind: "ignore" });
    expect(await adapter.parse(createZaloRequest(validUpdate({ messageId: null })))).toEqual({ kind: "ignore" });
  });
});

function createZaloRequest(
  body: unknown,
  headers: Record<string, string> = { "x-bot-api-secret-token": "zalo-secret" },
) {
  return {
    method: "POST",
    rawPath: "/",
    rawQueryString: "",
    headers,
    body: JSON.stringify(body),
  };
}

function validUpdate(overrides: {
  eventName?: string;
  text?: string;
  chatType?: string;
  senderId?: string;
  messageId?: string | null;
  isBot?: boolean;
} = {}) {
  return {
    event_name: overrides.eventName ?? "message.text.received",
    message: {
      ...(overrides.messageId === null ? {} : { message_id: overrides.messageId ?? "message-1" }),
      date: 1713916800,
      text: overrides.text ?? "hello zalo",
      chat: {
        id: "chat-1",
        chat_type: overrides.chatType ?? "PRIVATE",
      },
      from: {
        id: overrides.senderId ?? "user-1",
        name: "Ada",
        is_bot: overrides.isBot ?? false,
      },
    },
  };
}
