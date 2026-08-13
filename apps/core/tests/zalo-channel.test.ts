/**
 * Zalo channel adapter tests.
 * Cover webhook auth, allow-list filtering, text message normalization, and
 * outbound sends here.
 */

import { describe, expect, it } from "bun:test";
import type { ChannelParseResult } from "../src/shared/channels.ts";
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
      new Set(["user-1"]),
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
      new Set(["user-1"]),
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
      new Set(["user-1"]),
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
    const adapter = createZaloChannel("bot-token", "zalo-secret", new Set());

    expect(
      (
        await adapter.parse(
          createZaloRequest(validUpdate({ senderId: "customer-1" })),
        )
      ).kind,
    ).toBe("message");
  });

  it("ignores unsupported events, groups, blank text, bot messages, and unknown senders", async () => {
    const adapter = createZaloChannel(
      "bot-token",
      "zalo-secret",
      new Set(["user-1"]),
    );

    expectIgnoreReason(
      await adapter.parse(
        createZaloRequest(validUpdate({ eventName: "message.image.received" })),
      ),
      "unsupported_event:message.image.received",
    );
    expectIgnoreReason(
      await adapter.parse(
        createZaloRequest(validUpdate({ chatType: "GROUP" })),
      ),
      "unsupported_chat_type:GROUP",
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

  it("sends an image through sendPhoto with the caption truncated", async () => {
    const calls = await captureZaloCalls(async (actions) => {
      await actions.sendImage?.({
        url: "https://cdn.example.com/chart.png",
        caption: "x".repeat(2100),
      });
      await actions.sendImage?.({ url: "https://cdn.example.com/plain.png" });
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
    const calls = await captureZaloCalls(async (actions) => {
      await expect(
        actions.sendImage?.({ url: "/workspace/chart.png" }),
      ).rejects.toThrow("absolute http(s) image URL");
      await expect(
        actions.sendImage?.({ url: "data:image/png;base64,iVBORw0KGgo=" }),
      ).rejects.toThrow("absolute http(s) image URL");
    });

    expect(calls).toEqual([]);
  });
});

async function captureZaloCalls(
  run: (actions: ReturnType<typeof createZaloActions>) => Promise<void>,
): Promise<{ url: string; body: unknown }[]> {
  const calls: { url: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
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
