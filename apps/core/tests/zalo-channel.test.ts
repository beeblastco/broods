/**
 * Zalo channel adapter tests.
 * Cover webhook auth, allow-list filtering, text message normalization, and
 * outbound sends here.
 */

import { describe, expect, it } from "bun:test";
import type { UserContent } from "ai";
import type {
  ChannelAdapter,
  ChannelParseResult,
} from "../src/shared/channels.ts";
import {
  createZaloActions,
  createZaloChannel,
  type ZaloSource,
} from "../src/shared/zalo-channel.ts";

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

  it("ignores unsupported events, invalid messages, and unknown senders", async () => {
    const adapter = createZaloChannel("bot-token", "zalo-secret", {
      allowedUserIds: new Set(["user-1"]),
    });

    expectIgnoreReason(
      await adapter.parse(
        createZaloRequest(
          validUpdate({
            eventName: "message.unsupported.received",
            text: null,
          }),
        ),
      ),
      "unsupported_event:message.unsupported.received",
    );
    expectIgnoreReason(
      await adapter.parse(
        createZaloRequest(validUpdate({ eventName: "message.image.received" })),
      ),
      "missing_photo",
    );
    expectIgnoreReason(
      await adapter.parse(
        createZaloRequest(
          validUpdate({
            eventName: "message.image.received",
            media: { photo: "/relative/not-a-url.png" },
          }),
        ),
      ),
      "missing_photo",
    );
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
      "unsupported_event:missing",
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

  it("accepts group messages delivered by Zalo", async () => {
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

  it("normalizes inbound images, stickers, and voice notes into content parts", async () => {
    const adapter = createZaloChannel("bot-token", "zalo-secret");

    expect(
      await parsedContent(
        adapter,
        validUpdate({
          eventName: "message.image.received",
          media: {
            photo: "https://zalo.example/photo.jpg",
            caption: "  look at this  ",
          },
        }),
      ),
    ).toEqual([
      { type: "text", text: "look at this" },
      { type: "image", image: "https://zalo.example/photo.jpg" },
    ]);

    expect(
      await parsedContent(
        adapter,
        validUpdate({
          eventName: "message.image.received",
          media: { photo: "https://zalo.example/photo.jpg" },
        }),
      ),
    ).toEqual([{ type: "image", image: "https://zalo.example/photo.jpg" }]);

    expect(
      await parsedContent(
        adapter,
        validUpdate({
          eventName: "message.sticker.received",
          media: {
            sticker: "12345",
            url: "https://stickers.zaloapp.com/12345.png",
          },
        }),
      ),
    ).toEqual([
      { type: "image", image: "https://stickers.zaloapp.com/12345.png" },
    ]);

    expect(
      await parsedContent(
        adapter,
        validUpdate({
          eventName: "message.voice.received",
          media: { voice_url: "https://zalo.example/note.aac" },
        }),
      ),
    ).toEqual([
      {
        type: "file",
        data: "https://zalo.example/note.aac",
        mediaType: "audio/aac",
      },
    ]);
  });

  it("falls back to a link for any voice note that is not .aac", async () => {
    const adapter = createZaloChannel("bot-token", "zalo-secret");

    expect(
      await parsedContent(
        adapter,
        validUpdate({
          eventName: "message.voice.received",
          media: { voice_url: "https://zalo.example/note.mp3" },
        }),
      ),
    ).toEqual([
      { type: "text", text: "Voice message: https://zalo.example/note.mp3" },
    ]);

    expect(
      await parsedContent(
        adapter,
        validUpdate({
          eventName: "message.voice.received",
          media: { voice_url: "https://zalo.example/note" },
        }),
      ),
    ).toEqual([
      { type: "text", text: "Voice message: https://zalo.example/note" },
    ]);
  });

  it("sends an image through sendPhoto with the caption truncated", async () => {
    const calls = await captureZaloCalls(async (actions): Promise<void> => {
      await actions.sendImage?.(
        "https://cdn.example.com/chart.png",
        "x".repeat(2100),
      );
      await actions.sendImage?.("https://cdn.example.com/plain.png");
    });

    expect(calls).toEqual([
      {
        url: "https://bot-api.zaloplatforms.com/botbot-token/sendPhoto",
        body: {
          chat_id: "chat-1",
          photo: "https://cdn.example.com/chart.png",
          caption: "x".repeat(2000),
        },
      },
      {
        url: "https://bot-api.zaloplatforms.com/botbot-token/sendPhoto",
        body: {
          chat_id: "chat-1",
          photo: "https://cdn.example.com/plain.png",
        },
      },
    ]);
  });

  it("rejects image URLs Zalo could not fetch", async () => {
    const calls = await captureZaloCalls(async (actions): Promise<void> => {
      await expect(
        actions.sendImage?.("/workspace/chart.png"),
      ).rejects.toThrow("absolute http(s) image URL");
      await expect(
        actions.sendImage?.("data:image/png;base64,iVBORw0KGgo="),
      ).rejects.toThrow("absolute http(s) image URL");
    });

    expect(calls).toEqual([]);
  });

  it("sends a provider-native sticker through sendSticker", async (): Promise<void> => {
    const calls = await captureZaloCalls(async (actions): Promise<void> => {
      await actions.sendSticker?.(" sticker-123 ");
    });

    expect(calls).toEqual([
      {
        url: "https://bot-api.zaloplatforms.com/botbot-token/sendSticker",
        body: {
          chat_id: "chat-1",
          sticker: "sticker-123",
        },
      },
    ]);
  });
});

async function parsedContent(
  adapter: ChannelAdapter,
  update: unknown,
): Promise<UserContent> {
  const parsed = await adapter.parse(createZaloRequest(update));
  if (parsed.kind !== "message") {
    throw new Error(
      `Expected Zalo update to be accepted, got ${parsed.kind}: ${
        "reason" in parsed ? parsed.reason : ""
      }`,
    );
  }

  return parsed.message.content;
}

async function captureZaloCalls(
  run: (actions: ReturnType<typeof createZaloActions>) => Promise<void>,
): Promise<{ url: string; body: unknown }[]> {
  const calls: { url: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as unknown,
    });

    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
    });
  }) as typeof globalThis.fetch;
  try {
    await run(createZaloActions("bot-token", zaloSource()));
  } finally {
    globalThis.fetch = originalFetch;
  }

  return calls;
}

function zaloSource(): ZaloSource {
  return {
    chatId: "chat-1",
    chatType: "PRIVATE",
    messageId: "message-1",
    senderId: "user-1",
    eventName: "message.text.received",
  };
}

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
    media?: Record<string, unknown>;
  } = {},
) {
  return {
    event_name: overrides.eventName ?? "message.text.received",
    message: {
      ...(overrides.messageId === null
        ? {}
        : { message_id: overrides.messageId ?? "message-1" }),
      date: 1713916800,
      ...(overrides.text === null
        ? {}
        : { text: overrides.text ?? "hello zalo" }),
      ...overrides.media,
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
