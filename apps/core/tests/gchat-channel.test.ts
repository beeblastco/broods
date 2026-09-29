/** Google Chat adapter: Google's signed token, event parsing, and the reply send. */

import { GoogleChatAdapter } from "@chat-adapter/gchat";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createSign, generateKeyPairSync } from "node:crypto";
import type { ChannelRequest } from "../src/shared/channels.ts";
import {
  createGoogleChatChannel,
  parseServiceAccountKey,
} from "../src/shared/gchat-channel.ts";
import { TLS_CERT, TLS_KEY } from "./helpers/tls.ts";

const PROJECT_NUMBER = "123456789012";
const CHAT_ISSUER = "chat@system.gserviceaccount.com";
const ORIGINAL_FETCH = globalThis.fetch;
const OTHER_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();

const restorers: (() => void)[] = [];

afterEach((): void => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const restore of restorers.splice(0)) restore();
});

describe("google chat channel adapter", () => {
  it("accepts only a token Google Chat signed for the project number", async (): Promise<void> => {
    // Google Chat's issuer certificates, which the SDK fetches to verify.
    globalThis.fetch = Object.assign(
      async (): Promise<Response> => Response.json({ k1: TLS_CERT }),
      { preconnect: ORIGINAL_FETCH.preconnect },
    );
    const adapter = channel();
    const body = JSON.stringify(spaceEvent("@Agent hello", "hello"));

    expect(await adapter.authenticate(delivery(body, chatToken(TLS_KEY)))).toBe(
      true,
    );
    expect(
      await adapter.authenticate(delivery(body, chatToken(OTHER_KEY))),
    ).toBe(false);
    expect(await adapter.authenticate(delivery(body, undefined))).toBe(false);
  });

  it("turns a space mention into a turn in its thread, without the mention", async (): Promise<void> => {
    const parsed = await channel().parse(
      delivery(JSON.stringify(spaceEvent("@Agent ship it", " ship it")), ""),
    );
    if (parsed.kind !== "message") throw new Error("expected a message");

    expect(parsed.message).toMatchObject({
      eventId: "gchat:spaces/AAA/messages/M1",
      conversationKey: "gchat:spaces/AAA/threads/T1",
      channelName: "gchat",
      content: "ship it",
      identity: {
        channelId: "spaces/AAA",
        threadId: "spaces/AAA/threads/T1",
        userId: "users/42",
        userName: "Ada",
      },
      source: {
        messageName: "spaces/AAA/messages/M1",
        spaceName: "spaces/AAA",
        threadName: "spaces/AAA/threads/T1",
        userId: "users/42",
        userName: "Ada",
      },
    });
  });

  it("reads the event shape a Chat app that is not an add-on posts", async (): Promise<void> => {
    const addOn = spaceEvent("hi", "hi").chat.messagePayload;
    const classic = {
      type: "MESSAGE",
      message: addOn.message,
      space: { ...addOn.space, type: "DM", spaceType: "DIRECT_MESSAGE" },
    };
    const parsed = await channel().parse(delivery(JSON.stringify(classic), ""));
    if (parsed.kind !== "message") throw new Error("expected a message");

    expect(parsed.message.conversationKey).toBe("gchat:spaces/AAA");
    expect(parsed.message.content).toBe("hi");
  });

  it("posts the reply into the thread the message came from", async (): Promise<void> => {
    const post = spyOn(
      GoogleChatAdapter.prototype,
      "postMessage",
    ).mockResolvedValue({
      id: "spaces/AAA/messages/R1",
      threadId: "",
      raw: {},
    });
    restorers.push((): void => post.mockRestore());
    const adapter = channel();
    const parsed = await adapter.parse(
      delivery(JSON.stringify(spaceEvent("@Agent hi", "hi")), ""),
    );
    if (parsed.kind !== "message") throw new Error("expected a message");

    await adapter.actions(parsed.message).sendText("done");

    const [threadId, message] = post.mock.calls[0]!;
    expect(message).toEqual({ markdown: "done" });
    // The Chat SDK's thread id: the space, then the thread name in base64url.
    expect(threadId).toBe(
      `gchat:spaces/AAA:${Buffer.from("spaces/AAA/threads/T1").toString("base64url")}`,
    );
  });

  it("reads the service-account key JSON and refuses anything else", (): void => {
    expect(parseServiceAccountKey(serviceAccountJson())).toMatchObject({
      client_email: "agent@project.iam.gserviceaccount.com",
    });
    expect(parseServiceAccountKey("{not json")).toBeNull();
    expect(parseServiceAccountKey('{"client_email":"a"}')).toBeNull();
  });
});

function channel(): ReturnType<typeof createGoogleChatChannel> {
  return createGoogleChatChannel({
    allowedChannelIds: null,
    allowedUserIds: null,
    credentials: parseServiceAccountKey(serviceAccountJson())!,
    googleChatProjectNumber: PROJECT_NUMBER,
  });
}

// A token shaped like the ones Google Chat signs as its system account.
function chatToken(privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT", kid: "k1" })}.${encode(
    { iss: CHAT_ISSUER, aud: PROJECT_NUMBER, iat: now, exp: now + 300 },
  )}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(privateKey, "base64url");

  return `Bearer ${unsigned}.${signature}`;
}

function delivery(
  body: string,
  authorization: string | undefined,
): ChannelRequest {
  return {
    method: "POST",
    rawPath: "/v1/webhooks/acct_1/gchat",
    rawQueryString: "",
    headers:
      authorization === undefined ? {} : { authorization: authorization },
    body: body,
  };
}

function serviceAccountJson(): string {
  return JSON.stringify({
    type: "service_account",
    client_email: "agent@project.iam.gserviceaccount.com",
    private_key: TLS_KEY,
  });
}

// An add-on message event from a space, the app mentioned in the text.
function spaceEvent(
  text: string,
  argumentText: string,
): {
  chat: {
    messagePayload: {
      space: { name: string; type: string; spaceType: string };
      message: Record<string, unknown>;
    };
  };
} {
  return {
    chat: {
      messagePayload: {
        space: { name: "spaces/AAA", type: "ROOM", spaceType: "SPACE" },
        message: {
          name: "spaces/AAA/messages/M1",
          createTime: "2026-09-29T00:00:00.000Z",
          text: text,
          argumentText: argumentText,
          sender: { name: "users/42", displayName: "Ada", type: "HUMAN" },
          thread: { name: "spaces/AAA/threads/T1" },
        },
      },
    },
  };
}
