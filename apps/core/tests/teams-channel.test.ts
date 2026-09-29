/** Teams adapter: Bot Framework token check, activity parsing, and the reply send. */

import { decodeThreadId, TeamsAdapter } from "@chat-adapter/teams";
import { JwtValidator } from "@microsoft/teams.apps/dist/middleware/index.js";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createSign, generateKeyPairSync } from "node:crypto";
import { readAttachmentBytes } from "../src/harness/channel-media.ts";
import type { ChannelRequest } from "../src/shared/channels.ts";
import { createTeamsChannel } from "../src/shared/teams-channel.ts";

const APP_ID = "00000000-0000-0000-0000-00000000a99";
const CHANNEL_CONVERSATION = "19:general@thread.tacv2;messageid=1700000000000";
const SERVICE_URL = "https://smba.trafficmanager.net/emea/";
const SIGNING_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 });

// The validator's key lookup is private; standing in for Microsoft's key set
// is the only way to check real signatures offline.
interface SigningKeySource {
  getSigningKey(
    header: unknown,
    callback: (err: Error | null, key?: string) => void,
  ): void;
}

const restorers: (() => void)[] = [];

afterEach((): void => {
  for (const restore of restorers.splice(0)) restore();
});

describe("teams channel adapter", () => {
  it("rejects a delivery without a Bot Framework token", async (): Promise<void> => {
    const adapter = channel();
    const body = JSON.stringify(channelActivity("hello"));

    expect(await adapter.authenticate(delivery(body, undefined))).toBe(false);
    expect(await adapter.authenticate(delivery(body, "Bearer not-a-jwt"))).toBe(
      false,
    );
  });

  it("accepts a Bot Framework token for this app and the activity's serviceUrl", async (): Promise<void> => {
    useTestSigningKey();
    const body = JSON.stringify(channelActivity("hello"));

    expect(
      await channel().authenticate(
        delivery(body, `Bearer ${botFrameworkToken(SERVICE_URL)}`),
      ),
    ).toBe(true);
    expect(
      await channel().authenticate(
        delivery(body, `Bearer ${botFrameworkToken("https://evil.example/")}`),
      ),
    ).toBe(false);
  });

  it("refuses an Entra token, which any tenant can mint for the app id", async (): Promise<void> => {
    useTestSigningKey();
    const token = signedToken({
      aud: APP_ID,
      iss: "https://login.microsoftonline.com/other-tenant/v2.0",
      tid: "other-tenant",
    });

    expect(
      await channel().authenticate(
        delivery(JSON.stringify(channelActivity("hello")), `Bearer ${token}`),
      ),
    ).toBe(false);
  });

  it("reads a non-connector attachment URL through core's guarded fetch", async (): Promise<void> => {
    let reached = false;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (): Response => {
        reached = true;

        return new Response("internal");
      },
    });
    restorers.push((): void => void server.stop(true));
    const activity = {
      ...channelActivity("look"),
      attachments: [
        {
          contentType: "image/png",
          contentUrl: `http://127.0.0.1:${server.port}/latest/meta-data`,
        },
      ],
    };
    const parsed = await channel().parse(
      delivery(JSON.stringify(activity), ""),
    );
    if (parsed.kind !== "message") throw new Error("expected a message");

    const refusal = await readAttachmentBytes(
      parsed.message.attachments![0]!,
    ).catch((err: unknown): unknown => err);

    expect(String(refusal)).toContain("private or metadata address");
    expect(reached).toBe(false);
  });

  it("turns a channel mention into a turn in that thread", async (): Promise<void> => {
    const parsed = await channel().parse(
      delivery(JSON.stringify(channelActivity("<at>Agent</at> ship it")), ""),
    );
    if (parsed.kind !== "message") throw new Error("expected a message");

    expect(parsed.message).toMatchObject({
      eventId: `teams:${CHANNEL_CONVERSATION}:1700000000001`,
      conversationKey: `teams:${CHANNEL_CONVERSATION}`,
      channelName: "teams",
      content: "ship it",
      identity: {
        workspaceRef: "team-1",
        channelId: "19:general@thread.tacv2",
        userId: "aad-user-1",
        userName: "Ada",
      },
      source: {
        conversationId: CHANNEL_CONVERSATION,
        messageId: "1700000000001",
        userId: "aad-user-1",
        userName: "Ada",
      },
    });
  });

  it("ignores activities that are not messages", async (): Promise<void> => {
    const update = { ...channelActivity("hi"), type: "conversationUpdate" };

    expect(
      (await channel().parse(delivery(JSON.stringify(update), ""))).kind,
    ).toBe("ignore");
  });

  it("posts the reply to the conversation the message came from", async (): Promise<void> => {
    const post = spyOn(TeamsAdapter.prototype, "postMessage").mockResolvedValue(
      { id: "reply-1", threadId: "", raw: {} },
    );
    restorers.push((): void => post.mockRestore());
    const adapter = channel();
    const parsed = await adapter.parse(
      delivery(JSON.stringify(channelActivity("<at>Agent</at> hi")), ""),
    );
    if (parsed.kind !== "message") throw new Error("expected a message");

    await adapter.actions(parsed.message).sendText("done");

    const [threadId, message] = post.mock.calls[0]!;
    expect(message).toEqual({ markdown: "done" });
    expect(decodeThreadId(threadId)).toMatchObject({
      conversationId: CHANNEL_CONVERSATION,
      serviceUrl: SERVICE_URL,
    });
  });
});

function botFrameworkToken(serviceUrl: string): string {
  return signedToken({
    aud: APP_ID,
    iss: "https://api.botframework.com",
    serviceurl: serviceUrl,
  });
}

function channel(): ReturnType<typeof createTeamsChannel> {
  return createTeamsChannel({
    allowedChannelIds: null,
    allowedUserIds: null,
    appId: APP_ID,
    appPassword: "client-secret",
    appTenantId: "tenant-1",
  });
}

// A channel message as the Bot Framework posts it, the bot mentioned first.
function channelActivity(text: string): Record<string, unknown> {
  return {
    type: "message",
    id: "1700000000001",
    timestamp: "2026-09-29T00:00:00.000Z",
    serviceUrl: SERVICE_URL,
    channelId: "msteams",
    from: { id: "29:user-1", name: "Ada", aadObjectId: "aad-user-1" },
    conversation: {
      id: CHANNEL_CONVERSATION,
      conversationType: "channel",
      tenantId: "tenant-1",
    },
    recipient: { id: `28:${APP_ID}`, name: "Agent" },
    text: text,
    entities: [
      {
        type: "mention",
        text: "<at>Agent</at>",
        mentioned: { id: `28:${APP_ID}`, name: "Agent" },
      },
    ],
    channelData: {
      team: { id: "team-1" },
      channel: { id: "19:general@thread.tacv2" },
      tenant: { id: "tenant-1" },
    },
  };
}

function delivery(
  body: string,
  authorization: string | undefined,
): ChannelRequest {
  return {
    method: "POST",
    rawPath: "/v1/webhooks/acct_1/teams",
    rawQueryString: "",
    headers:
      authorization === undefined ? {} : { authorization: authorization },
    body: body,
  };
}

// An RS256 JWT signed with the test key, valid for ten minutes.
function signedToken(claims: Record<string, string>): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "RS256", kid: "test", typ: "JWT" })}.${encode({
    ...claims,
    exp: Math.floor(Date.now() / 1000) + 600,
  })}`;
  const signature = createSign("RSA-SHA256")
    .update(input)
    .sign(SIGNING_KEY.privateKey)
    .toString("base64url");

  return `${input}.${signature}`;
}

function useTestSigningKey(): void {
  const keySource: SigningKeySource = Object.getPrototypeOf(
    new JwtValidator({
      clientId: APP_ID,
      jwksUriOptions: { type: "uri", uri: "https://keys.invalid" },
    }),
  );
  const lookup = spyOn(keySource, "getSigningKey").mockImplementation(
    (_header, callback): void =>
      callback(
        null,
        SIGNING_KEY.publicKey
          .export({ format: "pem", type: "spki" })
          .toString(),
      ),
  );
  restorers.push((): void => lookup.mockRestore());
}
