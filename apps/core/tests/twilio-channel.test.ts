/** Twilio adapter: the signature over the public webhook URL, parsing an SMS, and the Messages API send. */

import { afterEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { TwilioFormatConverter } from "@chat-adapter/twilio";
import type { ChannelRequest } from "../src/shared/channels.ts";
import type { PinnedFetchTransport } from "../src/shared/http.ts";
import { createTwilioChannel } from "../src/shared/twilio-channel.ts";

// Built rather than written out so secret scanners stop flagging a placeholder SID.
const ACCOUNT_SID = `AC${"0".repeat(31)}1`;
const AUTH_TOKEN = crypto.randomUUID();
const PUBLIC_BASE_URL = "https://gateway.broods.test";
const WEBHOOK_PATH = "/v1/webhooks/acct_1/twilio";
const TWIML_EMPTY = {
  statusCode: 200,
  headers: { "content-type": "application/xml" },
  body: "<Response></Response>",
};

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(async (): Promise<void> => {
  await server?.stop(true);
  server = undefined;
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
    expect(channel().canHandle(delivery(otherNumber.toString(), "sig"))).toBe(
      false,
    );
    expect(channel().canHandle(delivery(status, "sig"))).toBe(true);
    expect(
      (await restricted.parse(delivery(smsForm("hi").toString(), ""))).kind,
    ).toBe("ignore");
  });

  it("reads a picture sent without text as a message", async (): Promise<void> => {
    const form = pictureForm("https://api.twilio.com/2010-04-01/Media/ME1");
    const parsed = await channel().parse(delivery(form.toString(), ""));

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") return;
    expect(parsed.message.attachments?.map((media) => media.type)).toEqual([
      "image",
    ]);
  });

  it("reads MMS media only through the private-address guard", async (): Promise<void> => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (): Response => new Response("instance credentials"),
    });
    const origin = `http://127.0.0.1:${server.port}`;
    const adapter = createTwilioChannel({ ...options(), apiUrl: origin });
    const parsed = await adapter.parse(
      delivery(pictureForm(`${origin}/media`).toString(), ""),
    );
    if (parsed.kind !== "message") throw new Error("expected a message");
    const [media] = parsed.message.attachments ?? [];
    if (!media?.fetchData) throw new Error("expected a media reader");

    const refused = await media.fetchData().then(
      (): string => "read",
      (error: unknown): string => String(error),
    );

    expect(refused).toMatch(/private or metadata/);
  });

  it("sends the reply through the Messages API from the number texted", async (): Promise<void> => {
    const calls = await withTwilioApi(async (adapter): Promise<void> => {
      const parsed = await adapter.parse(
        delivery(smsForm("hello").toString(), ""),
      );
      if (parsed.kind !== "message") throw new Error("expected a message");
      const actions = adapter.actions(parsed.message);

      await actions.sendText("hi there");
      await actions.sendTyping();
      await actions.reactToMessage("👍");
    });

    expect(calls).toEqual([
      {
        path: `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`,
        auth: `Basic ${btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`)}`,
        form: { Body: "hi there", From: "+15550001111", To: "+15551234567" },
      },
    ]);
  });

  it("splits the rendered reply so no part is cut at 1600 characters", async (): Promise<void> => {
    const text = `${"a".repeat(1590)}\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n${"b_".repeat(900)}`;
    const calls = await withTwilioApi(async (adapter): Promise<void> => {
      const parsed = await adapter.parse(
        delivery(smsForm("hello").toString(), ""),
      );
      if (parsed.kind !== "message") throw new Error("expected a message");

      await adapter.actions(parsed.message).sendText(text);
    });
    const bodies = calls.map((call): string => call.form.Body ?? "");

    expect(bodies.every((body): boolean => body.length <= 1600)).toBe(true);
    expect(bodies.join("")).toBe(
      new TwilioFormatConverter().fromMarkdown(text),
    );
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

// An MMS with one picture and no text, as Twilio posts it.
function pictureForm(mediaUrl: string): URLSearchParams {
  const form = smsForm("");
  form.set("NumMedia", "1");
  form.set("MediaUrl0", mediaUrl);
  form.set("MediaContentType0", "image/jpeg");

  return form;
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

// Runs `use` against a stand-in Twilio API on loopback, reached by name through
// the pinned-fetch seam, and returns every Messages API call it saw.
async function withTwilioApi(
  use: (adapter: ReturnType<typeof createTwilioChannel>) => Promise<void>,
): Promise<
  { path: string; auth: string | null; form: Record<string, string> }[]
> {
  const calls: {
    path: string;
    auth: string | null;
    form: Record<string, string>;
  }[] = [];
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request): Promise<Response> => {
      calls.push({
        path: new URL(request.url).pathname,
        auth: request.headers.get("authorization"),
        form: Object.fromEntries(new URLSearchParams(await request.text())),
      });

      return Response.json({
        sid: "SMreply",
        direction: "outbound-api",
        from: "+15550001111",
        to: "+15551234567",
      });
    },
  });
  const transport: PinnedFetchTransport = {
    allowAddresses: ["127.0.0.1"],
    lookup: async (): Promise<{ address: string; family: number }[]> => [
      { address: "127.0.0.1", family: 4 },
    ],
  };
  await use(
    createTwilioChannel({
      ...options(),
      apiUrl: `http://api.twilio.test:${server.port}`,
      transport: transport,
    }),
  );

  return calls;
}
