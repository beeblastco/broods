/** WhatsApp adapter: Meta's signature and handshake, parsing, and the Graph API send. */

import { afterEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { readAttachmentBytes } from "../src/harness/channel-media.ts";
import type { ChannelRequest } from "../src/shared/channels.ts";
import { createWhatsAppChannel } from "../src/shared/whatsapp-channel.ts";

const APP_SECRET = crypto.randomUUID();
const VERIFY_TOKEN = crypto.randomUUID();
const ORIGINAL_FETCH = globalThis.fetch;

afterEach((): void => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("whatsapp channel adapter", () => {
  it("answers Meta's subscription handshake only with the verify token", async (): Promise<void> => {
    const adapter = channel();
    const good = handshake(VERIFY_TOKEN);

    expect(adapter.canHandle(good)).toBe(true);
    expect(await adapter.authenticate(good)).toBe(true);
    expect(await adapter.authenticate(handshake("wrong-token"))).toBe(false);
    expect(await adapter.parse(good)).toEqual({
      kind: "response",
      reason: "subscription handshake",
      response: {
        statusCode: 200,
        headers: { "content-type": "text/plain" },
        body: "challenge-123",
      },
    });
  });

  it("rejects a delivery whose signature is not the app secret's", async (): Promise<void> => {
    const adapter = channel();
    const body = JSON.stringify(textWebhook("hello"));

    expect(await adapter.authenticate(delivery(body, sign(body)))).toBe(true);
    expect(
      await adapter.authenticate(delivery(body, sign(body, "other-secret"))),
    ).toBe(false);
    expect(await adapter.authenticate(delivery(body, ""))).toBe(false);
  });

  it("turns a text message into a turn for that customer", async (): Promise<void> => {
    const body = JSON.stringify(textWebhook("hello whatsapp"));
    const parsed = await channel().parse(delivery(body, sign(body)));

    expect(parsed).toEqual({
      kind: "message",
      message: {
        eventId: "whatsapp:wamid.1",
        conversationKey: "whatsapp:phone-1:15551234567",
        channelName: "whatsapp",
        content: "hello whatsapp",
        identity: {
          channelId: "15551234567",
          userId: "15551234567",
          userName: "Ada",
        },
        source: {
          messageId: "wamid.1",
          phoneNumberId: "phone-1",
          threadId: "whatsapp:phone-1:15551234567",
          userWaId: "15551234567",
          userName: "Ada",
        },
      },
    });
  });

  it("finds the message behind a status-only change for the same number", async (): Promise<void> => {
    const payload = textWebhook("after the receipt");
    const statusOnly = structuredClone(payload.entry[0]!);
    statusOnly.changes[0]!.value.messages = [];
    payload.entry.unshift(statusOnly);
    const body = JSON.stringify(payload);
    const parsed = await channel().parse(delivery(body, sign(body)));
    if (parsed.kind !== "message") throw new Error("expected a message");

    expect(parsed.message.content).toBe("after the receipt");
  });

  it("ignores deliveries for another number and senders outside the allow list", async (): Promise<void> => {
    const otherNumber = textWebhook("hi");
    otherNumber.entry[0]!.changes[0]!.value.metadata.phone_number_id =
      "phone-2";
    const body = JSON.stringify(otherNumber);
    const restricted = createWhatsAppChannel({
      ...options(),
      allowedUserIds: new Set(["15550000000"]),
    });
    const text = JSON.stringify(textWebhook("hi"));

    expect((await channel().parse(delivery(body, sign(body)))).kind).toBe(
      "ignore",
    );
    expect((await restricted.parse(delivery(text, sign(text)))).kind).toBe(
      "ignore",
    );
  });

  it("sends the reply and the typing indicator through the Graph API", async (): Promise<void> => {
    const calls: { url: string; body: unknown; auth: string | null }[] = [];
    globalThis.fetch = Object.assign(
      async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        calls.push({
          url: input instanceof Request ? input.url : input.toString(),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
          auth: new Headers(init?.headers).get("authorization"),
        });

        return Response.json({ messages: [{ id: "wamid.reply" }] });
      },
      { preconnect: ORIGINAL_FETCH.preconnect },
    );
    const body = JSON.stringify(textWebhook("hello"));
    const parsed = await channel().parse(delivery(body, sign(body)));
    if (parsed.kind !== "message") throw new Error("expected a message");
    const actions = channel().actions(parsed.message);

    await actions.sendText("**hi** there");
    await actions.sendTyping();

    expect(calls).toEqual([
      {
        url: "https://graph.facebook.com/v25.0/phone-1/messages",
        auth: "Bearer access-token",
        body: {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: "15551234567",
          type: "text",
          text: { preview_url: false, body: "*hi* there" },
        },
      },
      {
        url: "https://graph.facebook.com/v25.0/phone-1/messages",
        auth: "Bearer access-token",
        body: {
          messaging_product: "whatsapp",
          status: "read",
          message_id: "wamid.1",
          typing_indicator: { type: "text" },
        },
      },
    ]);
  });

  it("downloads media through core's guarded fetch, whatever apiUrl answers", async (): Promise<void> => {
    const reached: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request): Response => {
        reached.push(new URL(request.url).pathname);

        return Response.json({
          url: `http://127.0.0.1:${server.port}/latest/meta-data`,
        });
      },
    });
    const webhook: {
      entry: { changes: { value: { messages: object[] } }[] }[];
    } = textWebhook("");
    webhook.entry[0]!.changes[0]!.value.messages[0] = {
      from: "15551234567",
      id: "wamid.1",
      timestamp: "1700000000",
      type: "image",
      image: { id: "media-1", mime_type: "image/jpeg" },
    };
    const body = JSON.stringify(webhook);
    const parsed = await createWhatsAppChannel({
      ...options(),
      apiUrl: `http://127.0.0.1:${server.port}`,
    }).parse(delivery(body, sign(body)));
    if (parsed.kind !== "message") throw new Error("expected a message");

    const refusal = await readAttachmentBytes(
      parsed.message.attachments![0]!,
    ).catch((err: unknown): unknown => err);
    void server.stop(true);

    expect(String(refusal)).toContain("private or metadata address");
    expect(reached).toEqual([]);
  });
});

function channel(): ReturnType<typeof createWhatsAppChannel> {
  return createWhatsAppChannel(options());
}

function delivery(body: string, signature: string): ChannelRequest {
  return {
    method: "POST",
    rawPath: "/v1/webhooks/acct_1/whatsapp",
    rawQueryString: "",
    headers: { "x-hub-signature-256": signature },
    body: body,
  };
}

function handshake(token: string): ChannelRequest {
  return {
    method: "GET",
    rawPath: "/v1/webhooks/acct_1/whatsapp",
    rawQueryString: new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": token,
      "hub.challenge": "challenge-123",
    }).toString(),
    headers: {},
    body: "",
  };
}

function options(): Parameters<typeof createWhatsAppChannel>[0] {
  return {
    accessToken: "access-token",
    allowedChannelIds: null,
    allowedUserIds: null,
    appSecret: APP_SECRET,
    phoneNumberId: "phone-1",
    verifyToken: VERIFY_TOKEN,
  };
}

function sign(body: string, secret: string = APP_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

// The payload Meta documents for an inbound text message.
function textWebhook(text: string): {
  object: string;
  entry: {
    id: string;
    changes: {
      field: string;
      value: {
        messaging_product: string;
        metadata: { display_phone_number: string; phone_number_id: string };
        contacts: { profile: { name: string }; wa_id: string }[];
        messages: {
          from: string;
          id: string;
          timestamp: string;
          type: string;
          text: { body: string };
        }[];
      };
    }[];
  }[];
} {
  return {
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
                phone_number_id: "phone-1",
              },
              contacts: [{ profile: { name: "Ada" }, wa_id: "15551234567" }],
              messages: [
                {
                  from: "15551234567",
                  id: "wamid.1",
                  timestamp: "1713916800",
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}
