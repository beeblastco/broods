/** Twilio adapter: the signature over the public webhook URL, parsing an SMS, and the Messages API send. */

import { afterEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import type { ChannelRequest } from "../src/shared/channels.ts";
import { createTwilioChannel } from "../src/shared/twilio-channel.ts";

const ACCOUNT_SID = "AC00000000000000000000000000000001";
const AUTH_TOKEN = crypto.randomUUID();
const PUBLIC_BASE_URL = "https://gateway.broods.test";
const WEBHOOK_PATH = "/v1/webhooks/acct_1/twilio";
const ORIGINAL_FETCH = globalThis.fetch;
const TWIML_EMPTY = {
  statusCode: 200,
  headers: { "content-type": "application/xml" },
  body: "<Response></Response>",
};

afterEach((): void => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("twilio channel adapter", () => {
  it("accepts only a signature over the public webhook URL with the auth token", async (): Promise<void> => {
    const adapter = channel();
    const body = smsForm("hello").toString();
    const publicUrl = `${PUBLIC_BASE_URL}${WEBHOOK_PATH}`;

    expect(adapter.canHandle(delivery(body, sign(publicUrl, body)))).toBe(true);
    expect(
      await adapter.authenticate(delivery(body, sign(publicUrl, body))),
    ).toBe(true);
    expect(
      await adapter.authenticate(
        delivery(body, sign(publicUrl, body, "other-token")),
      ),
    ).toBe(false);
    expect(
      await adapter.authenticate(
        delivery(body, sign(`http://core.internal${WEBHOOK_PATH}`, body)),
      ),
    ).toBe(false);
    expect(
      await adapter.authenticate(
        delivery(smsForm("tampered").toString(), sign(publicUrl, body)),
      ),
    ).toBe(false);
  });

  it("signs against webhookUrl when the console URL is not the broods one", async (): Promise<void> => {
    const webhookUrl = "https://sms.example.com/hooks/twilio?tenant=1";
    const adapter = createTwilioChannel({
      ...options(),
      webhookUrl: webhookUrl,
    });
    const body = smsForm("hello").toString();

    expect(
      await adapter.authenticate(delivery(body, sign(webhookUrl, body))),
    ).toBe(true);
    expect(
      await adapter.authenticate(
        delivery(body, sign(`${PUBLIC_BASE_URL}${WEBHOOK_PATH}`, body)),
      ),
    ).toBe(false);
  });

  it("turns an inbound SMS into a turn and acknowledges with empty TwiML", async (): Promise<void> => {
    const body = smsForm("hello twilio").toString();
    const parsed = await channel().parse(
      delivery(body, sign(`${PUBLIC_BASE_URL}${WEBHOOK_PATH}`, body)),
    );

    expect(parsed).toEqual({
      kind: "message",
      ack: TWIML_EMPTY,
      message: {
        eventId: "twilio:SM00000000000000000000000000000001",
        conversationKey: "twilio:%2B15550001111:%2B15551234567",
        channelName: "twilio",
        content: "hello twilio",
        identity: { channelId: "+15551234567", userId: "+15551234567" },
        source: {
          from: "+15551234567",
          messageSid: "SM00000000000000000000000000000001",
          to: "+15550001111",
        },
      },
    });
  });

  it("ignores delivery receipts, other numbers and senders outside the allow list", async (): Promise<void> => {
    const status = new URLSearchParams({
      AccountSid: ACCOUNT_SID,
      From: "+15550001111",
      MessageSid: "SM2",
      MessageStatus: "delivered",
      To: "+15551234567",
    }).toString();
    const otherNumber = smsForm("hi");
    otherNumber.set("To", "+15559999999");
    const restricted = createTwilioChannel({
      ...options(),
      allowedUserIds: new Set(["+15550000000"]),
    });

    expect(await channel().parse(delivery(status, ""))).toEqual({
      kind: "ignore",
      reason: "unsupported:status",
      response: TWIML_EMPTY,
    });
    expect(
      (await channel().parse(delivery(otherNumber.toString(), ""))).kind,
    ).toBe("ignore");
    expect(
      (await restricted.parse(delivery(smsForm("hi").toString(), ""))).kind,
    ).toBe("ignore");
  });

  it("sends the reply through the Messages API from the number texted", async (): Promise<void> => {
    const calls: { url: string; body: string | null; auth: string | null }[] =
      [];
    globalThis.fetch = Object.assign(
      async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        calls.push({
          url: input instanceof Request ? input.url : input.toString(),
          body:
            init?.body instanceof URLSearchParams ? init.body.toString() : null,
          auth: new Headers(init?.headers).get("authorization"),
        });

        return Response.json({
          sid: "SMreply",
          direction: "outbound-api",
          from: "+15550001111",
          to: "+15551234567",
        });
      },
      { preconnect: ORIGINAL_FETCH.preconnect },
    );
    const body = smsForm("hello").toString();
    const parsed = await channel().parse(delivery(body, ""));
    if (parsed.kind !== "message") throw new Error("expected a message");
    const actions = channel().actions(parsed.message);

    await actions.sendText("hi there");
    await actions.sendTyping();
    await actions.reactToMessage("👍");

    expect(calls).toEqual([
      {
        url: `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`,
        auth: `Basic ${btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`)}`,
        body: new URLSearchParams({
          Body: "hi there",
          From: "+15550001111",
          To: "+15551234567",
        }).toString(),
      },
    ]);
  });
});

function channel(): ReturnType<typeof createTwilioChannel> {
  return createTwilioChannel(options());
}

function delivery(body: string, signature: string): ChannelRequest {
  return {
    method: "POST",
    rawPath: WEBHOOK_PATH,
    rawQueryString: "",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    body: body,
  };
}

function options(): Parameters<typeof createTwilioChannel>[0] {
  return {
    accountSid: ACCOUNT_SID,
    allowedChannelIds: null,
    allowedUserIds: null,
    authToken: AUTH_TOKEN,
    phoneNumber: "+15550001111",
    publicBaseUrl: PUBLIC_BASE_URL,
  };
}

// Twilio's documented scheme: the URL, then every field name and value in
// name order, HMAC-SHA1 with the auth token, base64.
function sign(url: string, body: string, token: string = AUTH_TOKEN): string {
  const params = [...new URLSearchParams(body)].sort(
    ([left], [right]): number => (left < right ? -1 : left > right ? 1 : 0),
  );
  const base = params.reduce(
    (text, [name, value]): string => `${text}${name}${value}`,
    url,
  );

  return createHmac("sha1", token).update(base).digest("base64");
}

// The form Twilio posts for an inbound SMS.
function smsForm(text: string): URLSearchParams {
  return new URLSearchParams({
    ToCountry: "US",
    ToState: "CA",
    SmsMessageSid: "SM00000000000000000000000000000001",
    NumMedia: "0",
    ToCity: "",
    FromZip: "94105",
    SmsSid: "SM00000000000000000000000000000001",
    FromState: "CA",
    SmsStatus: "received",
    FromCity: "SAN FRANCISCO",
    Body: text,
    FromCountry: "US",
    To: "+15550001111",
    ToZip: "",
    NumSegments: "1",
    MessageSid: "SM00000000000000000000000000000001",
    AccountSid: ACCOUNT_SID,
    From: "+15551234567",
    ApiVersion: "2010-04-01",
  });
}
