/** X adapter: the CRC challenge and delivery signature, parsing a DM, and the DM send. */

import { afterEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import type { ChannelRequest } from "../src/shared/channels.ts";
import { createXChannel } from "../src/shared/x-channel.ts";

const BOT_USER_ID = "2244994945";
const CONSUMER_SECRET = crypto.randomUUID();
const ORIGINAL_FETCH = globalThis.fetch;
const WEBHOOK_PATH = "/v1/webhooks/acct_1/x";

afterEach((): void => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("x channel adapter", () => {
  it("answers the CRC challenge with the consumer secret's HMAC", async (): Promise<void> => {
    const adapter = channel();
    const token = "crc-token-0123456789";
    const request = crc(token);

    expect(adapter.canHandle(request)).toBe(true);
    expect(await adapter.authenticate(request)).toBe(true);
    expect(await adapter.parse(request)).toEqual({
      kind: "response",
      reason: "crc challenge",
      response: {
        statusCode: 200,
        headers: { "content-type": "application/json;charset=utf-8" },
        body: JSON.stringify({ response_token: sign(token) }),
      },
    });
  });

  it("refuses to sign a CRC token shaped like an event body", async (): Promise<void> => {
    const parsed = await channel().parse(crc('{"data":{"event_type":"x"}}'));

    expect(parsed.kind === "response" && parsed.response.statusCode).toBe(400);
  });

  it("rejects a delivery whose signature is not the consumer secret's", async (): Promise<void> => {
    const adapter = channel();
    const body = JSON.stringify(dmWebhook("hello"));

    expect(await adapter.authenticate(delivery(body, sign(body)))).toBe(true);
    expect(
      await adapter.authenticate(delivery(body, sign(body, "other-secret"))),
    ).toBe(false);
    expect(await adapter.authenticate(delivery(body, ""))).toBe(false);
  });

  it("turns a received DM into a turn for that person", async (): Promise<void> => {
    const body = JSON.stringify(dmWebhook("hello x"));

    expect(await channel().parse(delivery(body, sign(body)))).toEqual({
      kind: "message",
      message: {
        eventId: "x:1950000000000000001",
        conversationKey: "x:dm:783214",
        channelName: "x",
        content: "hello x",
        identity: { channelId: "783214", userId: "783214", userName: "ada" },
        source: {
          dmEventId: "1950000000000000001",
          senderId: "783214",
          threadId: "x:dm:783214",
          userName: "ada",
        },
      },
    });
  });

  it("ignores the bot's own echo and DMs for another account", async (): Promise<void> => {
    const echo = dmWebhook("mine");
    echo.data.payload.direct_message_events[0]!.message_create.sender_id =
      BOT_USER_ID;
    const otherAccount = dmWebhook("hi");
    otherAccount.data.filter.user_id = "999";

    for (const payload of [echo, otherAccount]) {
      const body = JSON.stringify(payload);

      expect((await channel().parse(delivery(body, sign(body)))).kind).toBe(
        "ignore",
      );
    }
  });

  it("sends the reply as a DM to the sender", async (): Promise<void> => {
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

        return Response.json({
          data: { dm_conversation_id: "783214-2244994945", dm_event_id: "2" },
        });
      },
      { preconnect: ORIGINAL_FETCH.preconnect },
    );
    const body = JSON.stringify(dmWebhook("hello"));
    const parsed = await channel().parse(delivery(body, sign(body)));
    if (parsed.kind !== "message") throw new Error("expected a message");
    const actions = channel().actions(parsed.message);

    await actions.sendText("hi there");
    await actions.sendTyping();

    expect(calls).toEqual([
      {
        url: "https://api.x.com/2/dm_conversations/with/783214/messages",
        auth: "Bearer user-token",
        body: { text: "hi there" },
      },
    ]);
  });
});

function channel(): ReturnType<typeof createXChannel> {
  return createXChannel({
    allowedChannelIds: null,
    allowedUserIds: null,
    consumerSecret: CONSUMER_SECRET,
    userAccessToken: "user-token",
    userId: BOT_USER_ID,
  });
}

function crc(token: string): ChannelRequest {
  return {
    method: "GET",
    rawPath: WEBHOOK_PATH,
    rawQueryString: new URLSearchParams({
      crc_token: token,
      nonce: "abc",
    }).toString(),
    headers: {},
    body: "",
  };
}

function delivery(body: string, signature: string): ChannelRequest {
  return {
    method: "POST",
    rawPath: WEBHOOK_PATH,
    rawQueryString: "",
    headers: { "x-twitter-webhooks-signature": signature },
    body: body,
  };
}

function sign(value: string, secret: string = CONSUMER_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(value).digest("base64")}`;
}

// A `dm.received` event as the X Activity API delivers it.
function dmWebhook(text: string): {
  data: {
    event_type: string;
    event_uuid: string;
    filter: { user_id: string };
    includes: { users: { id: string; name: string; username: string }[] };
    payload: {
      for_user_id: string;
      direct_message_events: {
        type: string;
        id: string;
        created_timestamp: string;
        message_create: {
          target: { recipient_id: string };
          sender_id: string;
          message_data: { text: string };
        };
      }[];
    };
    tag: string;
  };
} {
  return {
    data: {
      event_type: "dm.received",
      event_uuid: "5a1d7b1e-0000-4000-8000-000000000001",
      filter: { user_id: BOT_USER_ID },
      includes: { users: [{ id: "783214", name: "Ada", username: "ada" }] },
      payload: {
        for_user_id: BOT_USER_ID,
        direct_message_events: [
          {
            type: "message_create",
            id: "1950000000000000001",
            created_timestamp: "1713916800000",
            message_create: {
              target: { recipient_id: BOT_USER_ID },
              sender_id: "783214",
              message_data: { text: text },
            },
          },
        ],
      },
      tag: "bot-dms",
    },
  };
}
