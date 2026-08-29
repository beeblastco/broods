/**
 * Zalo channel adapter tests.
 * Cover webhook auth, allow-list filtering, text message normalization, and
 * outbound sends here.
 */

import { describe, expect, it } from "bun:test";
import type { UserContent } from "ai";
import type { Attachment } from "chat";
import type {
  ChannelAdapter,
  ChannelParseResult,
  InboundMessage,
} from "../src/shared/channels.ts";
import {
  createZaloActions,
  createZaloChannel,
  type ZaloSource,
} from "../src/shared/zalo-channel.ts";

describe("zalo channel adapter", () => {
  it("authenticates matching webhook secrets and rejects mismatches", () => {
    const adapter = createZaloChannel("bot-token", "zalo-secret", {
      allowedChannelIds: null,
    });

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
    const adapter = createZaloChannel("bot-token", "zalo-secret", {
      allowedChannelIds: null,
    });
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
        userId: "user-1",
        userName: "Ada",
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
    const adapter = createZaloChannel("bot-token", "zalo-secret", {
      allowedChannelIds: null,
    });
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

  it("accepts any chat when the allow list is null", async () => {
    const adapter = createZaloChannel("bot-token", "zalo-secret", {
      allowedChannelIds: null,
    });

    expect(
      (
        await adapter.parse(
          createZaloRequest(validUpdate({ senderId: "customer-1" })),
        )
      ).kind,
    ).toBe("message");
  });

  it("ignores unsupported events and invalid messages", async () => {
    const adapter = createZaloChannel("bot-token", "zalo-secret");

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

  it("ignores chats outside the allow list", async () => {
    const adapter = createZaloChannel("bot-token", "zalo-secret", {
      allowedChannelIds: new Set(["group-1"]),
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
        createZaloRequest(
          validUpdate({ chatType: "GROUP", chatId: "group-9" }),
        ),
      ),
      "chat_not_allowed:group-9",
    );
  });

  it("drops a sender outside the user allow list", async () => {
    const adapter = createZaloChannel("bot-token", "zalo-secret", {
      allowedUserIds: new Set(["user-1"]),
    });

    expect(
      (
        await adapter.parse(
          createZaloRequest(validUpdate({ senderId: "user-1" })),
        )
      ).kind,
    ).toBe("message");
    expectIgnoreReason(
      await adapter.parse(
        createZaloRequest(validUpdate({ senderId: "user-9" })),
      ),
      "user_not_allowed:user-9",
    );
  });

  it("gates a private chat by the same allow list a group uses", async () => {
    const adapter = createZaloChannel("bot-token", "zalo-secret", {
      allowedChannelIds: new Set(["group-1"]),
    });

    expectIgnoreReason(
      await adapter.parse(createZaloRequest(validUpdate())),
      "chat_not_allowed:chat-1",
    );
  });

  it("normalizes inbound images, stickers, and voice notes into attachments", async () => {
    const adapter = createZaloChannel("bot-token", "zalo-secret");
    const captioned = validUpdate({
      eventName: "message.image.received",
      media: {
        photo: "https://zalo.example/photo.jpg",
        caption: "  look at this  ",
      },
    });

    // The caption is the message; the picture rides beside it rather than in it.
    expect(await parsedContent(adapter, captioned)).toBe("look at this");
    expect(await parsedAttachments(adapter, captioned)).toEqual([
      { type: "image", url: "https://zalo.example/photo.jpg", name: "photo" },
    ]);

    const uncaptioned = validUpdate({
      eventName: "message.image.received",
      media: { photo: "https://zalo.example/photo.jpg" },
    });
    expect(await parsedContent(adapter, uncaptioned)).toBe("");
    expect(await parsedAttachments(adapter, uncaptioned)).toEqual([
      { type: "image", url: "https://zalo.example/photo.jpg", name: "photo" },
    ]);

    expect(
      await parsedAttachments(
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
      {
        type: "image",
        url: "https://stickers.zaloapp.com/12345.png",
        name: "sticker",
      },
    ]);

    expect(
      await parsedAttachments(
        adapter,
        validUpdate({
          eventName: "message.voice.received",
          media: { voice_url: "https://zalo.example/note.aac" },
        }),
      ),
    ).toEqual([
      {
        type: "audio",
        url: "https://zalo.example/note.aac",
        name: "voice.aac",
        mimeType: "audio/aac",
      },
    ]);
  });

  it("falls back to a link for any voice note that is not .aac", async () => {
    const adapter = createZaloChannel("bot-token", "zalo-secret");
    const mp3 = validUpdate({
      eventName: "message.voice.received",
      media: { voice_url: "https://zalo.example/note.mp3" },
    });

    // Zalo only ever sends .aac, so a different extension means we do not know
    // what the file is — the link goes over as text and nothing is downloaded.
    expect(await parsedContent(adapter, mp3)).toBe(
      "Voice message: https://zalo.example/note.mp3",
    );
    expect(await parsedAttachments(adapter, mp3)).toEqual([]);

    expect(
      await parsedContent(
        adapter,
        validUpdate({
          eventName: "message.voice.received",
          media: { voice_url: "https://zalo.example/note" },
        }),
      ),
    ).toBe("Voice message: https://zalo.example/note");
  });

  it("sends an image through sendPhoto with the caption truncated", async () => {
    const calls = await captureZaloCalls(async (actions): Promise<void> => {
      await actions.sendImages?.(
        [{ type: "image", url: "https://cdn.example.com/chart.png" }],
        "x".repeat(2100),
      );
      await actions.sendImages?.([
        { type: "image", url: "https://cdn.example.com/plain.png" },
      ]);
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
        actions.sendImages?.([{ type: "image", url: "/workspace/chart.png" }]),
      ).rejects.toThrow("absolute http(s) image URL");
      await expect(
        actions.sendImages?.([
          { type: "image", url: "data:image/png;base64,iVBORw0KGgo=" },
        ]),
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
  return (await parsedMessage(adapter, update)).content;
}

// The media Zalo delivered, as the harness receives it. Zalo names every
// attachment by URL and never sends bytes, so there is no reader to compare and
// the descriptor is the whole contract.
async function parsedAttachments(
  adapter: ChannelAdapter,
  update: unknown,
): Promise<Attachment[]> {
  return (await parsedMessage(adapter, update)).attachments ?? [];
}

async function parsedMessage(
  adapter: ChannelAdapter,
  update: unknown,
): Promise<InboundMessage> {
  const parsed = await adapter.parse(createZaloRequest(update));
  if (parsed.kind !== "message") {
    throw new Error(
      `Expected Zalo update to be accepted, got ${parsed.kind}: ${
        "reason" in parsed ? parsed.reason : ""
      }`,
    );
  }

  return parsed.message;
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

function expectIgnoreReason(parsed: ChannelParseResult, reason: string): void {
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
