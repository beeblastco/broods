/**
 * Telegram channel adapter tests.
 * Cover webhook auth, allow-list filtering, and inbound message normalization here.
 */

import { describe, expect, it } from "bun:test";
import { createTelegramChannel } from "../functions/_shared/telegram-channel.ts";

describe("telegram channel adapter", () => {
  it("authenticates matching webhook secrets and rejects mismatches", () => {
    const adapter = createTelegramChannel("bot-token", "secret", new Set([123]), "👀");

    expect(adapter.authenticate(createRequest({
      update_id: 1,
      message: createMessage({ text: "hello" }),
    }, {
      "x-telegram-bot-api-secret-token": "secret",
    }))).toBe(true);

    expect(adapter.authenticate(createRequest({
      update_id: 1,
      message: createMessage({ text: "hello" }),
    }, {
      "x-telegram-bot-api-secret-token": "wrong",
    }))).toBe(false);
  });

  it("ignores updates without text content", () => {
    const adapter = createTelegramChannel("bot-token", "secret", new Set([123]), "👀");

    expect(adapter.parse(createRequest({
      update_id: 1,
      message: createMessage({ text: undefined }),
    }))).toEqual({ kind: "ignore" });
  });

  it("ignores chats outside the allow list", () => {
    const adapter = createTelegramChannel("bot-token", "secret", new Set([999]), "👀");

    expect(adapter.parse(createRequest({
      update_id: 1,
      message: createMessage({ text: "hello" }),
    }))).toEqual({ kind: "ignore" });
  });

  it("normalizes inbound messages from the main message payload", () => {
    const adapter = createTelegramChannel("bot-token", "secret", new Set([123]), "👀");

    const parsed = adapter.parse(createRequest({
      update_id: 7,
      message: createMessage({ text: "hello", message_id: 42 }),
    }));

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected Telegram message to be accepted");
    }

    expect(parsed.message.eventId).toBe("tg-7");
    expect(parsed.message.conversationKey).toBe("tg:123");
    expect(parsed.message.channelName).toBe("telegram");
    expect(parsed.message.content).toBe("hello");
    expect(parsed.message.source).toEqual({
      chatId: 123,
      messageId: "123:42",
      threadId: "telegram:123",
      fromUserId: 7,
      fromUsername: "alice",
    });
  });

  it("uses edited_message when no main message is present", () => {
    const adapter = createTelegramChannel("bot-token", "secret", new Set([123]), "👀");

    const parsed = adapter.parse(createRequest({
      update_id: 8,
      edited_message: createMessage({ text: "edited", message_id: 99 }),
    }));

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected Telegram edited message to be accepted");
    }

    expect(parsed.message.eventId).toBe("tg-8");
    expect(parsed.message.content).toBe("edited");
    expect(parsed.message.source).toEqual({
      chatId: 123,
      messageId: "123:99",
      threadId: "telegram:123",
      fromUserId: 7,
      fromUsername: "alice",
    });
  });
});

function createRequest(
  payload: Record<string, unknown>,
  headers: Record<string, string> = {
    "x-telegram-bot-api-secret-token": "secret",
  },
) {
  return {
    method: "POST",
    rawPath: "/",
    headers,
    body: JSON.stringify(payload),
  };
}

function createMessage(overrides: Partial<{
  message_id: number;
  text: string | undefined;
}> = {}) {
  return {
    message_id: overrides.message_id ?? 42,
    from: {
      id: 7,
      first_name: "Alice",
      username: "alice",
      is_bot: false,
    },
    chat: {
      id: 123,
      type: "private",
    },
    date: 1_700_000_000,
    ...(overrides.text !== undefined ? { text: overrides.text } : {}),
  };
}
