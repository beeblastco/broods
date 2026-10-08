/** Gmail adapter: the signed Pub/Sub push, the inbox listing, and the threaded reply. */

import { afterEach, describe, expect, it } from "bun:test";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import type { ChannelRequest } from "../src/shared/channels.ts";
import {
  createGmailChannel,
  type GmailChannelOptions,
} from "../src/shared/gmail-channel.ts";

const MAILBOX = "agent@example.com";
const PUSHER = "push@project.iam.gserviceaccount.com";
const SUBSCRIPTION = "projects/p/subscriptions/gmail";
const WEBHOOK_PATH = "/v1/webhooks/acct/gmail";
const BASE_URL = "https://api.example.com";
const ORIGINAL_FETCH = globalThis.fetch;
const KEYS = generateKeyPairSync("rsa", { modulusLength: 2048 });
const OTHER_KEYS = generateKeyPairSync("rsa", { modulusLength: 2048 });

interface Call {
  body: string;
  method: string;
  url: string;
}

afterEach((): void => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("gmail channel adapter", () => {
  it("accepts only a push Google signed for this subscription and mailbox", async (): Promise<void> => {
    stubGoogle([]);
    // Each case uses its own client so no verifier is cached across them.
    const adapter = channel({ clientId: "auth" });

    expect(await adapter.authenticate(push(MAILBOX, pushToken()))).toBe(true);
    expect(
      await adapter.authenticate(
        push(MAILBOX, pushToken(OTHER_KEYS.privateKey)),
      ),
    ).toBe(false);
    expect(
      await adapter.authenticate(
        push(MAILBOX, pushToken(KEYS.privateKey, "https://elsewhere")),
      ),
    ).toBe(false);
    expect(
      await adapter.authenticate(push("someone@example.com", pushToken())),
    ).toBe(false);
  });

  it("turns new inbox mail into turns, one conversation per thread", async (): Promise<void> => {
    const calls = stubGoogle([
      mail("m2", "t1", "Bob <bob@example.com>", "Second"),
      mail("m1", "t1", "Alice <Alice@Example.com>", "First"),
    ]);
    const parsed = await channel().parse(push(MAILBOX, ""));
    if (parsed.kind !== "batch") throw new Error("expected a batch");

    const [first, second] = parsed.results.map((result) => result.message);
    expect(first?.eventId).toBe("gmail:m1");
    expect(first?.conversationKey).toBe(`gmail:${MAILBOX}:t1`);
    expect(first?.identity?.userId).toBe("alice@example.com");
    expect(String(first?.content)).toContain("Subject: Re: plan\nDate:");
    expect(String(first?.content)).toContain("First");
    expect(second?.eventId).toBe("gmail:m2");
    const listing = calls.find((call) => call.url.includes("/messages?"));
    expect(new URL(listing?.url ?? BASE_URL).searchParams.get("q")).toStartWith(
      "in:inbox -from:me after:",
    );
  });

  it("skips the mailbox's own mail and senders off the allow list", async (): Promise<void> => {
    stubGoogle([
      mail("m1", "t1", `Agent <${MAILBOX}>`, "Mine"),
      mail("m2", "t2", "Eve <eve@example.com>", "Spam"),
    ]);
    const parsed = await channel({
      allowedUserIds: new Set(["alice@example.com"]),
    }).parse(push(MAILBOX, ""));

    expect(parsed.kind).toBe("ignore");
  });

  it("holds an allow list only for senders Gmail authenticated", async (): Promise<void> => {
    stubGoogle([
      mail(
        "m1",
        "t1",
        "Alice <alice@example.com>",
        "Real",
        "mx.google.com; dkim=pass header.i=@example.com; spf=pass; dmarc=pass (p=NONE) header.from=example.com",
      ),
      // Claims Alice, but Gmail saw the mail fail DMARC for her domain.
      mail(
        "m2",
        "t2",
        "Alice <alice@example.com>",
        "Forged",
        "mx.google.com; spf=fail; dmarc=fail (p=NONE) header.from=example.com",
      ),
      // A verdict a sender wrote under a host that only starts like Gmail's.
      mail(
        "m4",
        "t4",
        "Alice <alice@example.com>",
        "Spoofed verdict",
        "mx.google.com.evil.example; dmarc=pass (p=NONE) header.from=example.com",
      ),
      // Passes, but for a domain that only starts like hers.
      mail(
        "m3",
        "t3",
        "Alice <alice@example.co>",
        "Lookalike",
        "mx.google.com; dmarc=pass (p=NONE) header.from=example.com",
      ),
    ]);
    const parsed = await channel({
      allowedUserIds: new Set(["alice@example.com", "alice@example.co"]),
    }).parse(push(MAILBOX, ""));
    if (parsed.kind !== "batch") throw new Error("expected a batch");

    expect(parsed.results.map((result) => result.message.eventId)).toEqual([
      "gmail:m1",
    ]);
  });

  it("skips a message deleted before it was read and keeps the rest", async (): Promise<void> => {
    stubGoogle([
      mail("gone1", "t1", "Bob <bob@example.com>", "Deleted"),
      mail("m2", "t2", "Alice <alice@example.com>", "Kept"),
    ]);
    const parsed = await channel({ clientId: "gone" }).parse(push(MAILBOX, ""));
    if (parsed.kind !== "batch") throw new Error("expected a batch");

    expect(parsed.results.map((result) => result.message.eventId)).toEqual([
      "gmail:m2",
    ]);
  });

  it("acknowledges a mailbox it cannot read instead of failing the push", async (): Promise<void> => {
    globalThis.fetch = google(async (url): Promise<Response> => {
      return url.includes("/messages?")
        ? Response.json(
            { error: { code: 403, errors: [{ reason: "forbidden" }] } },
            { status: 403 },
          )
        : Response.json({});
    });
    const parsed = await channel({ clientId: "forbidden" }).parse(
      push(MAILBOX, ""),
    );

    expect(parsed).toEqual({ kind: "ignore", reason: "mailbox unreadable" });
  });

  it("drafts the reply in the thread unless autoSend is on", async (): Promise<void> => {
    for (const autoSend of [false, true]) {
      const calls = stubGoogle([
        mail("m1", "t1", "Alice <alice@example.com>", "Hi"),
      ]);
      const adapter = channel({
        autoSend: autoSend,
        clientId: `send-${autoSend}`,
      });
      const parsed = await adapter.parse(push(MAILBOX, ""));
      if (parsed.kind !== "batch" || !parsed.results[0]) {
        throw new Error("expected a batch");
      }

      await adapter.actions(parsed.results[0].message).sendText("On it.");

      const reply = calls.find(
        (call) => call.method === "POST" && call.url.includes("/users/"),
      );
      expect(reply?.url).toEndWith(autoSend ? "/messages/send" : "/drafts");
      expect(reply?.body).toContain('"threadId":"t1"');
    }
  });
});

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function channel(
  overrides: Partial<GmailChannelOptions> = {},
): ReturnType<typeof createGmailChannel> {
  return createGmailChannel({
    allowedChannelIds: null,
    allowedUserIds: null,
    autoSend: false,
    clientId: "client",
    clientSecret: "secret",
    mailbox: MAILBOX,
    publicBaseUrl: BASE_URL,
    refreshToken: "refresh",
    serviceAccountEmail: PUSHER,
    subscription: SUBSCRIPTION,
    ...overrides,
  });
}

// Routes the adapter's Google calls: the token endpoint, Google's signing keys,
// and the mailbox itself.
function google(
  mailbox: (url: string, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(
    async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return Response.json({ access_token: "access", expires_in: 3600 });
      }
      if (url.startsWith("https://www.googleapis.com/oauth2/v3/certs")) {
        return Response.json({
          keys: [
            {
              ...KEYS.publicKey.export({ format: "jwk" }),
              kid: "k1",
              alg: "RS256",
              use: "sig",
            },
          ],
        });
      }

      return mailbox(url, init);
    },
    { preconnect: ORIGINAL_FETCH.preconnect },
  );
}

// One stored message. `verdict` is the Authentication-Results header Gmail
// prepends on receipt, when it has one.
function mail(
  id: string,
  threadId: string,
  from: string,
  text: string,
  verdict?: string,
): Record<string, string> {
  const mime = [
    ...(verdict ? [`Authentication-Results: ${verdict}`] : []),
    `From: ${from}`,
    `To: ${MAILBOX}`,
    "Subject: Re: plan",
    `Message-ID: <${id}@example.com>`,
    "Date: Thu, 08 Oct 2026 10:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
  ].join("\r\n");

  return {
    id: id,
    threadId: threadId,
    internalDate: "1791460800000",
    raw: base64url(mime),
  };
}

function push(emailAddress: string, token: string): ChannelRequest {
  return {
    method: "POST",
    rawPath: WEBHOOK_PATH,
    rawQueryString: "",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({
      subscription: SUBSCRIPTION,
      message: {
        messageId: "pubsub-1",
        publishTime: new Date().toISOString(),
        data: base64url(
          JSON.stringify({ emailAddress: emailAddress, historyId: "42" }),
        ),
      },
    }),
  };
}

// An RS256 ID token as Pub/Sub signs it for a push subscription.
function pushToken(
  key: KeyObject = KEYS.privateKey,
  audience = `${BASE_URL}${WEBHOOK_PATH}`,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(
    JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }),
  );
  const payload = base64url(
    JSON.stringify({
      aud: audience,
      email: PUSHER,
      email_verified: true,
      exp: now + 600,
      iat: now,
      iss: "https://accounts.google.com",
      sub: "1",
    }),
  );
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(key);

  return `${header}.${payload}.${base64url(signature)}`;
}

// Serves `messages` as the whole inbox and records every mailbox call.
function stubGoogle(messages: Record<string, string>[]): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = google(async (url, init): Promise<Response> => {
    calls.push({
      body: String(init?.body ?? ""),
      method: init?.method ?? "GET",
      url: url,
    });
    if (url.includes("/messages?")) {
      return Response.json({
        messages: messages.map((m) => ({ id: m.id, threadId: m.threadId })),
      });
    }
    const found = messages.find((m) => url.includes(`/messages/${m.id}`));
    // A message deleted between the listing and the read.
    if (found?.id?.startsWith("gone")) {
      return Response.json({ error: { code: 404 } }, { status: 404 });
    }
    if (found) return Response.json(found);
    if (url.endsWith("/drafts")) {
      return Response.json({ id: "d1", message: { id: "r1", threadId: "t1" } });
    }

    return Response.json({ id: "r1", threadId: "t1" });
  });

  return calls;
}
