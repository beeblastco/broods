import { afterEach, describe, expect, test } from "bun:test";
import type { InboundMessage } from "../../../../apps/core/src/shared/channels.ts";
import { createDiscordChannel } from "../../../../apps/core/src/shared/discord-channel.ts";
import { createWhatsAppChannel } from "../../../../apps/core/src/shared/whatsapp-channel.ts";

interface Seen {
  method: string;
  url: string;
  body: string;
}

const originalFetch = globalThis.fetch;
const seen: Seen[] = [];

function stubFetch(): void {
  const stub = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    seen.push({
      method: init?.method ?? "GET",
      url: String(input instanceof Request ? input.url : input),
      body: typeof init?.body === "string" ? init.body : "",
    });

    return String(input as string | URL).includes("discord.com")
      ? new Response(null, { status: 204 })
      : Response.json({ messages: [{ id: "wamid.react" }] });
  };
  globalThis.fetch = Object.assign(stub, {
    preconnect: originalFetch.preconnect,
  });
}

function message(
  channelName: string,
  source: Record<string, unknown>,
): InboundMessage {
  return {
    eventId: `${channelName}:1`,
    conversationKey: `${channelName}:1`,
    channelName: channelName,
    content: "hi",
    source: source,
  };
}

afterEach((): void => {
  globalThis.fetch = originalFetch;
  seen.length = 0;
});

describe("discord reactions", (): void => {
  const actions = (
    messageId: string | undefined,
  ): ReturnType<ReturnType<typeof createDiscordChannel>["actions"]> =>
    createDiscordChannel("bot-token", "0".repeat(64), null, null).actions(
      message("discord", {
        applicationId: "app-1",
        channelId: "channel-1",
        guildId: "guild-1",
        ...(messageId ? { messageId: messageId } : {}),
      }),
    );

  test("react with the given emoji, or eyes by default", async (): Promise<void> => {
    stubFetch();

    await actions("m-1").reactToMessage("🔥");
    await actions("m-1").reactToMessage();

    const urls = seen.map((entry) => decodeURIComponent(entry.url));
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain(
      "/channels/channel-1/messages/m-1/reactions/🔥/@me",
    );
    expect(urls[1]).toContain("/reactions/👀/@me");
    expect(seen.every((entry) => entry.method === "PUT")).toBe(true);
  });

  test("do nothing without a message to react to", async (): Promise<void> => {
    stubFetch();

    await actions(undefined).reactToMessage("🔥");

    expect(seen).toEqual([]);
  });
});

describe("whatsapp reactions", (): void => {
  const actions = (): ReturnType<
    ReturnType<typeof createWhatsAppChannel>["actions"]
  > =>
    createWhatsAppChannel({
      accessToken: "access-token",
      allowedChannelIds: null,
      allowedUserIds: null,
      appSecret: "app-secret",
      phoneNumberId: "106540352242922",
      verifyToken: "verify-token",
    }).actions(
      message("whatsapp", {
        messageId: "wamid.1",
        phoneNumberId: "106540352242922",
        threadId: "whatsapp:106540352242922:15551234567",
        userWaId: "15551234567",
      }),
    );

  test("an explicit emoji is sent as a reaction to the message", async (): Promise<void> => {
    stubFetch();

    await actions().reactToMessage("👍");

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toContain("/106540352242922/messages");
    const body = JSON.parse(seen[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body["type"]).toBe("reaction");
    expect(JSON.stringify(body)).toContain("wamid.1");
  });

  test("no emoji sends nothing", async (): Promise<void> => {
    stubFetch();

    await actions().reactToMessage();

    expect(seen).toEqual([]);
  });
});
