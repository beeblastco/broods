/**
 * Zalo channel adapter tests.
 * Cover webhook auth, allow-list filtering, and text message normalization here.
 */

import { describe, expect, it } from "bun:test";
import type { ChannelParseResult } from "../src/shared/channels.ts";
import { createZaloChannel } from "../src/shared/zalo-channel.ts";

describe("zalo channel adapter", () => {
  it("authenticates matching webhook secrets and rejects mismatches", () => {
    const adapter = createZaloChannel(
      "bot-token",
      "zalo-secret",
      { allowedUserIds: new Set(["user-1"]) },
    );

    expect(
      adapter.authenticate(
        createZaloRequest(validUpdate(), {
          "x-bot-api-secret-token": "zalo-secret",
        }),
      ),
    ).toBe(true);
    expect(
      adapter.authenticate(
        createZaloRequest(validUpdate(), {
          "x-bot-api-secret-token": "wrong-secret",
        }),
      ),
    ).toBe(false);
    expect(adapter.authenticate(createZaloRequest(validUpdate(), {}))).toBe(
      false,
    );
  });

  it("normalizes text webhook events into direct conversations", async () => {
    const adapter = createZaloChannel(
      "bot-token",
      "zalo-secret",
      { allowedUserIds: new Set(["user-1"]) },
    );
    const parsed = await adapter.parse(
      createZaloRequest(
        validUpdate({
          text: "  hello zalo  ",
        }),
      ),
    );

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
      identity: {
        channelId: "chat-1",
        actorId: "user-1",
        actorName: "Ada",
      },
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
    const adapter = createZaloChannel(
      "bot-token",
      "zalo-secret",
      { allowedUserIds: new Set(["user-1"]) },
    );
    const parsed = await adapter.parse(
      createZaloRequest({
        ok: true,
        result: validUpdate({ text: "wrapped" }),
      }),
    );

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected wrapped Zalo event to be accepted");
    }
    expect(parsed.message.content).toBe("wrapped");
  });

  it("accepts any private sender when the allow list is omitted", async () => {
    const adapter = createZaloChannel("bot-token", "zalo-secret");

    expect(
      (
        await adapter.parse(
          createZaloRequest(validUpdate({ senderId: "customer-1" })),
        )
      ).kind,
    ).toBe("message");
  });

  it("accepts any private sender when the allow list is empty", async () => {
    const adapter = createZaloChannel("bot-token", "zalo-secret", {
      allowedUserIds: new Set(),
    });

    expect(
      (
        await adapter.parse(
          createZaloRequest(validUpdate({ senderId: "customer-1" })),
        )
      ).kind,
    ).toBe("message");
  });

  it("ignores unknown chat types, blank text, bot messages, and unknown senders", async () => {
    const adapter = createZaloChannel("bot-token", "zalo-secret", {
      allowedUserIds: new Set(["user-1"]),
    });

    expectIgnoreReason(
      await adapter.parse(
        createZaloRequest(validUpdate({ chatType: "CHANNEL" })),
      ),
      "unsupported_chat_type:CHANNEL",
    );
    expectIgnoreReason(
      await adapter.parse(createZaloRequest(validUpdate({ text: "   " }))),
      "missing_text",
    );
    const richLink = await adapter.parse(
      createZaloRequest(validUpdate({ text: { url: "https://example.com" } })),
    );
    expectIgnoreReason(richLink, "missing_text");
    if (richLink.kind !== "ignore") {
      throw new Error("Expected malformed Zalo rich-link text to be ignored");
    }
    expect(richLink.reason).toContain('"textType":"object"');
    expect(richLink.reason).toContain('"textFields":["url"]');
    expectIgnoreReason(
      await adapter.parse(createZaloRequest({ event_name: 42 })),
      "missing_message_id",
    );
    expectIgnoreReason(
      await adapter.parse(createZaloRequest(validUpdate({ isBot: true }))),
      "bot_message",
    );
    expectIgnoreReason(
      await adapter.parse(
        createZaloRequest(validUpdate({ senderId: "user-2" })),
      ),
      "sender_not_allowed:user-2",
    );
    expectIgnoreReason(
      await adapter.parse(createZaloRequest(validUpdate({ messageId: null }))),
      "missing_message_id",
    );
  });

  it("notifies the sender when Zalo delivers a message without content", async () => {
    const adapter = createZaloChannel("bot-token", "zalo-secret");
    const parsed = await adapter.parse(
      createZaloRequest(
        validUpdate({ eventName: "message.unsupported.received", text: null }),
      ),
    );

    expect(parsed.kind).toBe("notify");
    if (parsed.kind !== "notify") {
      throw new Error("Expected Zalo unsupported event to notify the sender");
    }

    expect(parsed.reason).toContain(
      "unsupported_event:message.unsupported.received",
    );
    expect(parsed.reason).toContain('"textType":"undefined"');
    expect(parsed.text).toContain("link");
    // The notice routes to the same conversation a real message would, so a
    // reply lands in the chat that sent the unreadable message.
    expect(parsed.message.content).toBe("");
    expect(parsed.message.conversationKey).toBe("zalo:chat-1");
    expect(parsed.message.identity?.channelId).toBe("chat-1");
    expect(parsed.message.source).toEqual({
      chatId: "chat-1",
      chatType: "PRIVATE",
      messageId: "message-1",
      senderId: "user-1",
      senderName: "Ada",
      eventName: "message.unsupported.received",
      date: 1713916800,
    });
    expect(() => adapter.actions(parsed.message)).not.toThrow();
  });

  it("notifies with a text-only notice for media events", async () => {
    const adapter = createZaloChannel("bot-token", "zalo-secret");
    const parsed = await adapter.parse(
      createZaloRequest(validUpdate({ eventName: "message.image.received" })),
    );

    expect(parsed.kind).toBe("notify");
    if (parsed.kind !== "notify") {
      throw new Error("Expected Zalo image event to notify the sender");
    }
    expect(parsed.text).toBe("I can only read text messages right now.");
  });

  it("stays silent about unsupported group messages", async () => {
    const adapter = createZaloChannel("bot-token", "zalo-secret");

    expectIgnoreReason(
      await adapter.parse(
        createZaloRequest(
          validUpdate({
            eventName: "message.unsupported.received",
            chatType: "GROUP",
            chatId: "group-1",
            text: null,
          }),
        ),
      ),
      "unsupported_event:message.unsupported.received",
    );
  });

  it("runs the agent on every group message when no bot name is configured", async () => {
    const adapter = createZaloChannel("bot-token", "zalo-secret");
    const parsed = await adapter.parse(
      createZaloRequest(
        validUpdate({ chatType: "GROUP", chatId: "group-1", text: "standup?" }),
      ),
    );

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected Zalo group message to be accepted");
    }
    expect(parsed.message.conversationKey).toBe("zalo:group-1");
    expect(parsed.message.identity?.channelId).toBe("group-1");
    expect(parsed.message.content).toBe("standup?");
    expect(parsed.message.source.chatType).toBe("GROUP");
  });

  it("stores unaddressed group messages as context and runs on a mention", async () => {
    const adapter = createZaloChannel("bot-token", "zalo-secret", {
      botName: "Brood",
    });

    const chatter = await adapter.parse(
      createZaloRequest(
        validUpdate({
          chatType: "GROUP",
          chatId: "group-1",
          text: "lunch at noon",
        }),
      ),
    );
    expect(chatter.kind).toBe("context");
    if (chatter.kind !== "context") {
      throw new Error("Expected unaddressed Zalo group message to be context");
    }
    expect(chatter.message.content).toBe("lunch at noon");

    const addressed = await adapter.parse(
      createZaloRequest(
        validUpdate({
          chatType: "GROUP",
          chatId: "group-1",
          text: "@Brood what is on the calendar?",
        }),
      ),
    );
    expect(addressed.kind).toBe("message");
    if (addressed.kind !== "message") {
      throw new Error("Expected mentioned Zalo group message to run the agent");
    }
    expect(addressed.message.content).toBe("what is on the calendar?");

    const lowercased = await adapter.parse(
      createZaloRequest(
        validUpdate({
          chatType: "GROUP",
          chatId: "group-1",
          text: "@brood remind me later",
        }),
      ),
    );
    expect(lowercased.kind).toBe("message");
    if (lowercased.kind !== "message") {
      throw new Error("Expected a mixed-case mention to run the agent");
    }
    expect(lowercased.message.content).toBe("remind me later");
  });

  it("matches the bot name as a mention, not a substring", async () => {
    const adapter = createZaloChannel("bot-token", "zalo-secret", {
      botName: "Brood",
    });

    const embedded = await adapter.parse(
      createZaloRequest(
        validUpdate({
          chatType: "GROUP",
          chatId: "group-1",
          text: "I am brooding",
        }),
      ),
    );
    expect(embedded.kind).toBe("context");
    if (embedded.kind !== "context") {
      throw new Error("Expected an embedded bot name to stay unaddressed");
    }
    expect(embedded.message.content).toBe("I am brooding");

    const mixed = await adapter.parse(
      createZaloRequest(
        validUpdate({
          chatType: "GROUP",
          chatId: "group-1",
          text: "brooding @Brood help",
        }),
      ),
    );
    expect(mixed.kind).toBe("message");
    if (mixed.kind !== "message") {
      throw new Error("Expected a real mention to run the agent");
    }
    expect(mixed.message.content).toBe("brooding help");
  });

  it("treats a blank bot name as no bot name", async () => {
    const adapter = createZaloChannel("bot-token", "zalo-secret", {
      botName: "   ",
    });
    const parsed = await adapter.parse(
      createZaloRequest(
        validUpdate({
          chatType: "GROUP",
          chatId: "group-1",
          text: "no mention anywhere",
        }),
      ),
    );

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected a blank bot name to gate nothing");
    }
    expect(parsed.message.content).toBe("no mention anywhere");
  });

  it("keeps the bot name gate out of private chats", async () => {
    const adapter = createZaloChannel("bot-token", "zalo-secret", {
      botName: "Brood",
    });
    const parsed = await adapter.parse(
      createZaloRequest(validUpdate({ text: "no mention here" })),
    );

    expect(parsed.kind).toBe("message");
  });

  it("ignores groups outside the group allow list", async () => {
    const adapter = createZaloChannel("bot-token", "zalo-secret", {
      allowedGroupIds: new Set(["group-1"]),
    });

    expect(
      (
        await adapter.parse(
          createZaloRequest(
            validUpdate({ chatType: "GROUP", chatId: "group-1" }),
          ),
        )
      ).kind,
    ).toBe("message");
    expectIgnoreReason(
      await adapter.parse(
        createZaloRequest(validUpdate({ chatType: "GROUP", chatId: "group-9" })),
      ),
      "group_not_allowed:group-9",
    );
  });

  it("leaves private chats untouched by the group allow list", async () => {
    const adapter = createZaloChannel("bot-token", "zalo-secret", {
      allowedGroupIds: new Set(["group-1"]),
    });

    expect((await adapter.parse(createZaloRequest(validUpdate()))).kind).toBe(
      "message",
    );
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
    headers: headers,
    body: JSON.stringify(body),
  };
}

function expectIgnoreReason(
  parsed: ChannelParseResult,
  reason: string,
): void {
  expect(parsed.kind).toBe("ignore");
  if (parsed.kind !== "ignore") {
    throw new Error("Expected Zalo webhook to be ignored");
  }
  expect(parsed.reason?.startsWith(`${reason} details=`)).toBe(true);
}

function validUpdate(
  overrides: {
    eventName?: string;
    text?: unknown;
    chatType?: string;
    chatId?: string;
    senderId?: string;
    messageId?: string | null;
    isBot?: boolean;
  } = {},
) {
  return {
    event_name: overrides.eventName ?? "message.text.received",
    message: {
      ...(overrides.messageId === null
        ? {}
        : { message_id: overrides.messageId ?? "message-1" }),
      date: 1713916800,
      ...(overrides.text === null ? {} : { text: overrides.text ?? "hello zalo" }),
      chat: {
        id: overrides.chatId ?? "chat-1",
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
