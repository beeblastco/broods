/** Messenger and Instagram adapters: Meta's handshake and signature, parsing, and the Send API. */

import { afterEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import type { ChannelRequest } from "../src/shared/channels.ts";
import { createInstagramChannel } from "../src/shared/instagram-channel.ts";
import { createMessengerChannel } from "../src/shared/messenger-channel.ts";

const APP_SECRET = crypto.randomUUID();
const VERIFY_TOKEN = crypto.randomUUID();
const ORIGINAL_FETCH = globalThis.fetch;

interface SentRequest {
  url: string;
  body: unknown;
}

afterEach((): void => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("messenger channel adapter", () => {
  it("answers Meta's subscription handshake only with the verify token", async (): Promise<void> => {
    const adapter = messenger();
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
    const adapter = messenger();
    const body = JSON.stringify(messengerWebhook("hello"));

    expect(await adapter.authenticate(delivery(body, sign(body)))).toBe(true);
    expect(
      await adapter.authenticate(delivery(body, sign(body, "other-secret"))),
    ).toBe(false);
    expect(await adapter.authenticate(delivery(body, "sha256=00"))).toBe(false);
  });

  it("turns a Page message into a turn for that person", async (): Promise<void> => {
    const body = JSON.stringify(messengerWebhook("hello messenger"));

    expect(await messenger().parse(delivery(body, sign(body)))).toEqual({
      kind: "message",
      message: {
        eventId: "messenger:psid-1:mid.1",
        conversationKey: "messenger:page-1:psid-1",
        channelName: "messenger",
        content: "hello messenger",
        identity: {
          workspaceRef: "page-1",
          channelId: "psid-1",
          userId: "psid-1",
        },
        source: {
          messageId: "mid.1",
          recipientId: "page-1",
          senderId: "psid-1",
          threadId: "messenger:psid-1",
        },
      },
    });
  });

  it("ignores echoes and senders outside the allow list", async (): Promise<void> => {
    const echo = messengerWebhook("mine");
    echo.entry[0]!.messaging[0]!.message.is_echo = true;
    const echoBody = JSON.stringify(echo);
    const body = JSON.stringify(messengerWebhook("hi"));
    const restricted = createMessengerChannel({
      ...messengerOptions(),
      allowedUserIds: new Set(["psid-2"]),
    });

    expect(
      (await messenger().parse(delivery(echoBody, sign(echoBody)))).kind,
    ).toBe("ignore");
    expect((await restricted.parse(delivery(body, sign(body)))).kind).toBe(
      "ignore",
    );
  });

  it("sends the reply and the typing indicator through the Send API", async (): Promise<void> => {
    const calls = recordFetch({
      message_id: "mid.reply",
      recipient_id: "psid-1",
    });
    const body = JSON.stringify(messengerWebhook("hello"));
    const parsed = await messenger().parse(delivery(body, sign(body)));
    if (parsed.kind !== "message") throw new Error("expected a message");
    const actions = messenger().actions(parsed.message);

    await actions.sendText("hi there");
    await actions.sendTyping();

    expect(calls).toEqual([
      {
        url: "https://graph.facebook.com/v21.0/me/messages?access_token=page-token",
        body: {
          recipient: { id: "psid-1" },
          message: { text: "hi there" },
          messaging_type: "RESPONSE",
        },
      },
      {
        url: "https://graph.facebook.com/v21.0/me/messages?access_token=page-token",
        body: { recipient: { id: "psid-1" }, sender_action: "typing_on" },
      },
    ]);
    expect("sendImages" in actions).toBe(false);
  });

  it("splits a reply past the Send API limit instead of truncating it", async (): Promise<void> => {
    const calls = recordFetch({
      message_id: "mid.reply",
      recipient_id: "psid-1",
    });
    const body = JSON.stringify(messengerWebhook("hello"));
    const parsed = await messenger().parse(delivery(body, sign(body)));
    if (parsed.kind !== "message") throw new Error("expected a message");

    await messenger()
      .actions(parsed.message)
      .sendText(`${"a".repeat(1500)} ${"b".repeat(1500)}`);

    expect(
      calls.map((call) => JSON.stringify(call.body).length < 2000),
    ).toEqual([true, true]);
  });
});

describe("instagram channel adapter", () => {
  it("rejects a delivery whose signature is not the app secret's", async (): Promise<void> => {
    const body = JSON.stringify(instagramWebhook("hello"));

    expect(await instagram().authenticate(delivery(body, sign(body)))).toBe(
      true,
    );
    expect(
      await instagram().authenticate(delivery(body, sign(body, "other"))),
    ).toBe(false);
  });

  it("turns a DM with a picture into a turn, and skips other accounts", async (): Promise<void> => {
    const payload = instagramWebhook("look");
    payload.entry[0]!.messaging[0]!.message.attachments = [
      { type: "image", payload: { url: "https://lookaside.fbsbx.com/ig/1" } },
    ];
    const body = JSON.stringify(payload);
    const other = instagramWebhook("not ours");
    other.entry[0]!.id = "ig-other";
    const otherBody = JSON.stringify(other);

    expect(await instagram().parse(delivery(body, sign(body)))).toEqual({
      kind: "message",
      message: {
        eventId: "instagram:igsid-1:ig-mid.1",
        conversationKey: "instagram:ig-1:igsid-1",
        channelName: "instagram",
        content: "look",
        attachments: [
          { type: "image", url: "https://lookaside.fbsbx.com/ig/1" },
        ],
        identity: {
          workspaceRef: "ig-1",
          channelId: "igsid-1",
          userId: "igsid-1",
        },
        source: {
          messageId: "ig-mid.1",
          recipientId: "ig-1",
          senderId: "igsid-1",
          threadId: "instagram:ig-1:igsid-1",
        },
      },
    });
    expect(
      (await instagram().parse(delivery(otherBody, sign(otherBody)))).kind,
    ).toBe("ignore");
  });

  it("sends the reply to the account's messages endpoint", async (): Promise<void> => {
    const calls = recordFetch({
      message_id: "ig-reply",
      recipient_id: "igsid-1",
    });
    const body = JSON.stringify(instagramWebhook("hello"));
    const parsed = await instagram().parse(delivery(body, sign(body)));
    if (parsed.kind !== "message") throw new Error("expected a message");

    await instagram().actions(parsed.message).sendText("**hi** there");

    expect(calls).toEqual([
      {
        url: "https://graph.instagram.com/v26.0/ig-1/messages",
        body: {
          recipient: { id: "igsid-1" },
          message: { text: "hi there" },
          messaging_type: "RESPONSE",
        },
      },
    ]);
  });

  it("splits a long picture caption instead of truncating it", async (): Promise<void> => {
    const calls = recordFetch({
      message_id: "ig-reply",
      recipient_id: "igsid-1",
    });
    const body = JSON.stringify(instagramWebhook("hello"));
    const parsed = await instagram().parse(delivery(body, sign(body)));
    if (parsed.kind !== "message") throw new Error("expected a message");

    await instagram()
      .actions(parsed.message)
      .sendImages?.(
        [{ type: "image", url: "https://cdn.example.com/cat.png" }],
        `${"é".repeat(400)} ${"ü".repeat(400)}`,
      );

    expect(calls.map((call) => call.body)).toMatchObject([
      { message: { attachment: { type: "image" } } },
      { message: { text: "é".repeat(400) } },
      { message: { text: "ü".repeat(400) } },
    ]);
  });
});

function delivery(body: string, signature: string): ChannelRequest {
  return {
    method: "POST",
    rawPath: "/v1/webhooks/acct_test/messenger",
    rawQueryString: "",
    headers: { "x-hub-signature-256": signature },
    body: body,
  };
}

function handshake(token: string): ChannelRequest {
  return {
    method: "GET",
    rawPath: "/v1/webhooks/acct_test/messenger",
    rawQueryString: `hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=challenge-123`,
    headers: {},
    body: "",
  };
}

function instagram(): ReturnType<typeof createInstagramChannel> {
  return createInstagramChannel({
    accessToken: "ig-token",
    accountId: "ig-1",
    allowedChannelIds: null,
    allowedUserIds: null,
    appSecret: APP_SECRET,
    verifyToken: VERIFY_TOKEN,
  });
}

function instagramWebhook(text: string): {
  object: string;
  entry: {
    id: string;
    time: number;
    messaging: {
      sender: { id: string };
      recipient: { id: string };
      timestamp: number;
      message: {
        mid: string;
        text: string;
        attachments?: { type: string; payload: { url: string } }[];
      };
    }[];
  }[];
} {
  return {
    object: "instagram",
    entry: [
      {
        id: "ig-1",
        time: 1_760_000_000_000,
        messaging: [
          {
            sender: { id: "igsid-1" },
            recipient: { id: "ig-1" },
            timestamp: 1_760_000_000_000,
            message: { mid: "ig-mid.1", text: text },
          },
        ],
      },
    ],
  };
}

function messenger(): ReturnType<typeof createMessengerChannel> {
  return createMessengerChannel(messengerOptions());
}

function messengerOptions(): Parameters<typeof createMessengerChannel>[0] {
  return {
    allowedChannelIds: null,
    allowedUserIds: null,
    appSecret: APP_SECRET,
    pageAccessToken: "page-token",
    verifyToken: VERIFY_TOKEN,
  };
}

function messengerWebhook(text: string): {
  object: string;
  entry: {
    id: string;
    time: number;
    messaging: {
      sender: { id: string };
      recipient: { id: string };
      timestamp: number;
      message: { mid: string; text: string; is_echo?: boolean };
    }[];
  }[];
} {
  return {
    object: "page",
    entry: [
      {
        id: "page-1",
        time: 1_760_000_000_000,
        messaging: [
          {
            sender: { id: "psid-1" },
            recipient: { id: "page-1" },
            timestamp: 1_760_000_000_000,
            message: { mid: "mid.1", text: text },
          },
        ],
      },
    ],
  };
}

// Records every Graph call and answers each with the same Send API result.
function recordFetch(result: Record<string, string>): SentRequest[] {
  const calls: SentRequest[] = [];
  globalThis.fetch = Object.assign(
    async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({
        url: input instanceof Request ? input.url : input.toString(),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });

      return Response.json(result);
    },
    { preconnect: ORIGINAL_FETCH.preconnect },
  );

  return calls;
}

function sign(body: string, secret: string = APP_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}
