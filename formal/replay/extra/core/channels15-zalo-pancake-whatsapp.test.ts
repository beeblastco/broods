import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type {
  ChannelParseResult,
  InboundMessage,
} from "../../../../apps/core/src/shared/channels.ts";
import {
  createPancakeActions,
  createPancakeChannel,
  type PancakeSource,
} from "../../../../apps/core/src/shared/pancake-channel.ts";
import { createWhatsAppChannel } from "../../../../apps/core/src/shared/whatsapp-channel.ts";
import { createZaloChannel } from "../../../../apps/core/src/shared/zalo-channel.ts";

const ORIGINAL_FETCH = globalThis.fetch;
const PHONE = "106540352242922";
const APP_SECRET = "app-secret";

afterEach((): void => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function stubFetch(status: number, body: string): void {
  globalThis.fetch = (async (): Promise<Response> =>
    new Response(body, { status: status })) as unknown as typeof fetch;
}

function message(): InboundMessage {
  return {
    eventId: "event-1",
    conversationKey: "conversation-1",
    channelName: "zalo",
    content: [],
    source: {
      chatId: "chat-1",
      chatType: "PRIVATE",
      messageId: "message-1",
      senderId: "user-1",
      eventName: "message.text.received",
    },
  } as unknown as InboundMessage;
}

async function parseWhatsApp(
  inbound: Record<string, unknown>,
): Promise<ChannelParseResult> {
  const channel = createWhatsAppChannel({
    accessToken: "access-token",
    allowedChannelIds: null,
    allowedUserIds: null,
    appSecret: APP_SECRET,
    phoneNumberId: PHONE,
    verifyToken: "verify-token",
  });
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "15550001111",
                phone_number_id: PHONE,
              },
              contacts: [{ profile: { name: "Ada" }, wa_id: "15551234567" }],
              messages: [
                { id: "wamid.9", timestamp: "1713916800", ...inbound },
              ],
            },
          },
        ],
      },
    ],
  });

  return await channel.parse({
    method: "POST",
    rawPath: "/v1/webhooks/acct_1/whatsapp",
    rawQueryString: "",
    headers: {
      "x-hub-signature-256": `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`,
    },
    body: body,
  });
}

describe("parseInbound", (): void => {
  test("ignores a reaction", async (): Promise<void> => {
    const parsed = await parseWhatsApp({
      from: "15551234567",
      type: "reaction",
      reaction: { emoji: "x", message_id: "wamid.1" },
    });

    expect(parsed).toEqual({
      kind: "ignore",
      reason: "no message for this number",
    });
  });

  test("ignores a sender with no phone number", async (): Promise<void> => {
    const parsed = await parseWhatsApp({
      type: "text",
      text: { body: "hi" },
    });

    expect(parsed).toEqual({
      kind: "ignore",
      reason: "no sender phone number",
    });
  });

  test("ignores a message type with no text or media", async (): Promise<void> => {
    const parsed = await parseWhatsApp({
      from: "15551234567",
      type: "unsupported",
    });

    expect(parsed).toEqual({
      kind: "ignore",
      reason: "unsupported_type:unsupported",
    });
  });
});

describe("parsePancakeWebhook", (): void => {
  const payload = {
    event_type: "messaging",
    page_id: "page-1",
    data: {
      conversation: { id: "conv-1", from: { id: "user-1" } },
      message: {
        id: "message-1",
        message: "hello",
        type: "INBOX",
        from: { id: "user-1", page_customer_id: "customer-1" },
      },
    },
  };

  async function parse(
    channels: Set<string> | null,
    users: Set<string> | null,
  ): Promise<ChannelParseResult> {
    return await createPancakeChannel(
      "page-1",
      "token",
      "secret",
      channels,
      users,
    ).parse({
      method: "POST",
      rawPath: "/v1/webhooks/acct_1/pancake",
      rawQueryString: "secret=secret",
      headers: {},
      body: JSON.stringify(payload),
    });
  }

  test("ignores a conversation outside the allow list", async (): Promise<void> => {
    expect(await parse(new Set(["conv-9"]), null)).toEqual({ kind: "ignore" });
  });

  test("ignores a sender outside the allow list", async (): Promise<void> => {
    expect(await parse(null, new Set(["user-9"]))).toEqual({ kind: "ignore" });
  });

  test("accepts a listed conversation and sender", async (): Promise<void> => {
    const parsed = await parse(new Set(["conv-1"]), new Set(["user-1"]));

    expect(parsed.kind).toBe("message");
  });
});

describe("pancake parseJsonBody", (): void => {
  const source: PancakeSource = {
    pageId: "page-1",
    conversationId: "conversation-1",
    messageId: "message-1",
    messageType: "INBOX",
  };

  test.each<[string, string]>([
    ["a JSON scalar", "7"],
    ["text that is not JSON", "<html>"],
  ])(
    "a failed send with %s keeps the raw body in the error",
    async (_label, body): Promise<void> => {
      stubFetch(502, body);

      await expect(
        createPancakeActions("page-token", source).sendText("hi"),
      ).rejects.toThrow(`Pancake send message failed (502): ${body}`);
    },
  );
});

describe("zalo", (): void => {
  const channel = createZaloChannel("bot-token", "zalo-secret");

  test("ignores a voice message with no voice url", (): void => {
    const parsed = channel.parse({
      method: "POST",
      rawPath: "/v1/webhooks/acct_1/zalo",
      rawQueryString: "",
      headers: {},
      body: JSON.stringify({
        event_name: "message.voice.received",
        message: {
          message_id: "m1",
          chat: { id: "chat-1", chat_type: "PRIVATE" },
          from: { id: "user-1" },
        },
      }),
    });

    expect(parsed.kind).toBe("ignore");
    expect(parsed.kind === "ignore" ? parsed.reason : "").toStartWith(
      "missing_voice_url",
    );
  });

  test.each<[string, string]>([
    ["a JSON scalar", "7"],
    ["text that is not JSON", "<html>"],
  ])(
    "an ok reply that is %s counts as sent",
    async (_label, body): Promise<void> => {
      stubFetch(200, body);

      await expect(
        channel.actions(message()).sendText("hi"),
      ).resolves.toBeUndefined();
    },
  );

  test("a failed reply with a JSON scalar body names the raw text", async (): Promise<void> => {
    stubFetch(500, "7");

    await expect(channel.actions(message()).sendText("hi")).rejects.toThrow(
      "Zalo sendMessage failed (500)",
    );
  });
});
