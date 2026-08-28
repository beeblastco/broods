/**
 * Channel action tests.
 * Cover outbound Discord, Slack, and Pancake reply branches here with mocked fetch calls.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createDiscordChannel } from "../src/shared/discord-channel.ts";
import { createPancakeChannel } from "../src/shared/pancake-channel.ts";
import { createSlackChannel } from "../src/shared/slack-channel.ts";
import { createTelegramChannel } from "../src/shared/telegram-channel.ts";
import { createZaloChannel } from "../src/shared/zalo-channel.ts";

type FetchInput = string | URL | Request;

interface FetchCall {
  input: FetchInput;
  init?: RequestInit;
}

const originalFetch = globalThis.fetch;
const TEST_DISCORD_PUBLIC_KEY = "0".repeat(64);

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("telegram channel actions", () => {
  it("sends Telegram photos and stickers to the current topic", async (): Promise<void> => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(
      telegramMessageResponse(50, "photo"),
      telegramMessageResponse(51, "sticker"),
    );

    const actions = createTelegramChannel(
      "bot-token",
      "secret",
      new Set(["123"]),
      null,
      "👀",
    ).actions(
      createMessage({
        chatId: 123,
        messageId: "123:42",
        messageThreadId: 7,
        threadId: "telegram:123:7",
      }),
    );

    await actions.sendImages?.(
      [{ type: "image", url: "https://cdn.example.com/chart.png" }],
      "A useful chart",
    );
    await actions.sendSticker?.("telegram-file-id");

    expect(fetchMock.calls).toHaveLength(2);
    expect(toUrl(fetchMock.calls[0]!.input)).toBe(
      "https://api.telegram.org/botbot-token/sendPhoto",
    );
    expect(JSON.parse(String(fetchMock.calls[0]!.init?.body))).toEqual({
      chat_id: "123",
      photo: "https://cdn.example.com/chart.png",
      caption: "A useful chart",
      message_thread_id: 7,
    });
    expect(toUrl(fetchMock.calls[1]!.input)).toBe(
      "https://api.telegram.org/botbot-token/sendSticker",
    );
    expect(JSON.parse(String(fetchMock.calls[1]!.init?.body))).toEqual({
      chat_id: 123,
      sticker: "telegram-file-id",
      message_thread_id: 7,
    });
  });

  it("sends a batch of Telegram pictures as albums of ten", async (): Promise<void> => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(
      telegramMediaGroupResponse(10),
      telegramMediaGroupResponse(2),
    );

    const actions = createTelegramChannel(
      "bot-token",
      "secret",
      new Set(["123"]),
      null,
      "👀",
    ).actions(
      createMessage({
        chatId: 123,
        messageId: "123:42",
        threadId: "telegram:123",
      }),
    );

    await actions.sendImages?.(
      Array.from({ length: 12 }, (_unused, index) => ({
        type: "image" as const,
        url: `https://cdn.example.com/${index}.png`,
      })),
      "twelve charts",
    );

    // Twelve is past Telegram's ten-per-album ceiling, so it goes out as two
    // albums rather than one rejected request, and only the first carries the
    // caption.
    expect(fetchMock.calls.map((call): string => toUrl(call.input))).toEqual([
      "https://api.telegram.org/botbot-token/sendMediaGroup",
      "https://api.telegram.org/botbot-token/sendMediaGroup",
    ]);
    const [first, second] = fetchMock.calls.map((call) =>
      telegramMediaGroup(call.init?.body),
    );
    expect(first!.media).toHaveLength(10);
    expect(second!.media).toHaveLength(2);
    expect(first!.media[0]).toMatchObject({
      type: "photo",
      media: "https://cdn.example.com/0.png",
      caption: "twelve charts",
    });
    expect(second!.media[0]).toMatchObject({
      type: "photo",
      media: "https://cdn.example.com/10.png",
    });
    expect(second!.media[0]?.caption).toBeUndefined();
  });

  it("sends Telegram documents through the document endpoint", async (): Promise<void> => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(telegramMessageResponse(62, "doc"));

    const actions = createTelegramChannel(
      "bot-token",
      "secret",
      new Set(["123"]),
      null,
      "👀",
    ).actions(
      createMessage({
        chatId: 123,
        messageId: "123:42",
        threadId: "telegram:123",
      }),
    );

    await actions.sendFiles?.(
      [
        {
          type: "file",
          url: "https://gateway.test/media/token",
          name: "declaration.pdf",
          mimeType: "application/pdf",
        },
      ],
      "công bố sản phẩm",
    );

    // A lone attachment is a plain send, not an album, and `type` is what picks
    // sendDocument over sendPhoto.
    expect(toUrl(fetchMock.calls[0]!.input)).toBe(
      "https://api.telegram.org/botbot-token/sendDocument",
    );
    expect(JSON.parse(String(fetchMock.calls[0]!.init?.body))).toMatchObject({
      chat_id: "123",
      document: "https://gateway.test/media/token",
      caption: "công bố sản phẩm",
    });
  });

  it("uses the Chat SDK adapter for sending, streaming, typing, and reactions", async () => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(
      telegramMessageResponse(50, "hello"),
      jsonResponse({ ok: true, result: true }),
      jsonResponse({ ok: true, result: true }),
      telegramMessageResponse(51, "stream done"),
      jsonResponse({ ok: true, result: true }),
      jsonResponse({ ok: true, result: true }),
    );

    const actions = createTelegramChannel(
      "bot-token",
      "secret",
      new Set(["123"]),
      null,
      "👀",
    ).actions(
      createMessage({
        chatId: 123,
        messageId: "123:42",
        threadId: "telegram:123",
      }),
    );

    await actions.sendText("hello **telegram**");
    expect(actions.stream).toBeDefined();
    if (!actions.stream) {
      throw new Error("Expected Telegram actions to support SDK streaming");
    }
    const messageId = await actions.stream(
      (async function* () {
        yield "stream";
        yield " done";
      })(),
    );
    await actions.sendTyping();
    await actions.reactToMessage(":heart:");

    expect(fetchMock.calls).toHaveLength(6);
    expect(toUrl(fetchMock.calls[0]!.input)).toBe(
      "https://api.telegram.org/botbot-token/sendRichMessage",
    );
    expect(JSON.parse(String(fetchMock.calls[0]!.init?.body))).toMatchObject({
      chat_id: "123",
    });
    expect(
      JSON.stringify(JSON.parse(String(fetchMock.calls[0]!.init?.body))),
    ).toContain("telegram");

    expect(messageId).toBe("123:51");
    expect(toUrl(fetchMock.calls[1]!.input)).toBe(
      "https://api.telegram.org/botbot-token/sendRichMessageDraft",
    );
    expect(toUrl(fetchMock.calls[2]!.input)).toBe(
      "https://api.telegram.org/botbot-token/sendRichMessageDraft",
    );
    expect(toUrl(fetchMock.calls[3]!.input)).toBe(
      "https://api.telegram.org/botbot-token/sendRichMessage",
    );
    expect(JSON.parse(String(fetchMock.calls[3]!.init?.body))).toMatchObject({
      chat_id: "123",
      rich_message: {
        markdown: "stream done",
      },
    });

    expect(toUrl(fetchMock.calls[4]!.input)).toBe(
      "https://api.telegram.org/botbot-token/sendChatAction",
    );
    expect(JSON.parse(String(fetchMock.calls[4]!.init?.body))).toMatchObject({
      chat_id: "123",
      action: "typing",
    });

    expect(toUrl(fetchMock.calls[5]!.input)).toBe(
      "https://api.telegram.org/botbot-token/setMessageReaction",
    );
    expect(JSON.parse(String(fetchMock.calls[5]!.init?.body))).toMatchObject({
      chat_id: "123",
      message_id: 42,
      reaction: [{ type: "emoji", emoji: ":heart:" }],
    });
  });

  it("splits long final Telegram replies before SDK formatting to avoid truncation", async () => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(
      telegramMessageResponse(50, "first"),
      telegramMessageResponse(51, "second"),
    );

    const actions = createTelegramChannel(
      "bot-token",
      "secret",
      new Set(["123"]),
      null,
      "👀",
    ).actions(
      createMessage({
        chatId: 123,
        messageId: "123:42",
        threadId: "telegram:123",
      }),
    );

    await actions.sendText(`${"a".repeat(3600)} ${"b".repeat(20)}`);

    expect(fetchMock.calls).toHaveLength(2);
    expect(toUrl(fetchMock.calls[0]!.input)).toBe(
      "https://api.telegram.org/botbot-token/sendRichMessage",
    );
    expect(toUrl(fetchMock.calls[1]!.input)).toBe(
      "https://api.telegram.org/botbot-token/sendRichMessage",
    );
  });
});

describe("discord channel actions", () => {
  it("uploads documents as multipart rather than posting a URL", async (): Promise<void> => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(jsonResponse({ id: "message-1" }));

    const actions = createDiscordChannel(
      "bot-token",
      TEST_DISCORD_PUBLIC_KEY,
      null,
      null,
    ).actions(
      createMessage({
        applicationId: "app-1",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "message-1",
      }),
    );

    await actions.sendFiles?.(
      [
        {
          type: "file",
          url: "https://gateway.test/media/token",
          name: "declaration.pdf",
          mimeType: "application/pdf",
          fetchData: async (): Promise<Buffer> => Buffer.from("pdf-bytes"),
        },
      ],
      "here you go",
    );

    // Discord has no URL attachment at all, so the bytes have to go up as
    // multipart; a link in the payload would simply never render.
    const body = fetchMock.calls[0]!.init?.body;
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(JSON.parse(String(form.get("payload_json"))).content).toBe(
      "here you go",
    );
    const upload = form.get("files[0]");
    expect(upload).toBeInstanceOf(Blob);
    expect(await (upload as Blob).text()).toBe("pdf-bytes");
  });

  it("names an unnamed upload from its URL so it can still preview", async (): Promise<void> => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(
      new Response("png-bytes"),
      jsonResponse({ id: "message-1" }),
    );

    const actions = createDiscordChannel(
      "bot-token",
      TEST_DISCORD_PUBLIC_KEY,
      null,
      null,
    ).actions(
      createMessage({
        applicationId: "app-1",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "message-1",
      }),
    );

    // The public push endpoint sends a bare URL with no name and no reader.
    // Uploading that as "file" would arrive extensionless and refuse to preview,
    // so the name comes off the URL and the bytes are fetched.
    await actions.sendImages?.([
      { type: "image", url: "https://cdn.example.com/a/chart.png?v=2" },
    ]);

    expect(toUrl(fetchMock.calls[0]!.input)).toBe(
      "https://cdn.example.com/a/chart.png?v=2",
    );
    const form = fetchMock.calls[1]!.init?.body as FormData;
    const upload = form.get("files[0]") as File;
    expect(upload.name).toBe("chart.png");
    expect(await upload.text()).toBe("png-bytes");
  });

  it("uses the Chat SDK adapter for deferred replies and typing", async () => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(
      jsonResponse({ id: "reply-1" }),
      new Response("", { status: 204 }),
    );

    const actions = createDiscordChannel(
      "bot-token",
      TEST_DISCORD_PUBLIC_KEY,
      null,
      null,
    ).actions(
      createMessage({
        applicationId: "app-1",
        interactionToken: "interaction-token",
        interactionId: "interaction-1",
        channelId: "channel-1",
      }),
    );

    await actions.sendText(`${"hello ".repeat(450)}tail`);
    await actions.sendTyping();
    await actions.reactToMessage();

    expect(fetchMock.calls).toHaveLength(2);
    expect(toUrl(fetchMock.calls[0]!.input)).toBe(
      "https://discord.com/api/v10/webhooks/app-1/interaction-token/messages/@original",
    );
    expect(fetchMock.calls[0]!.init?.method).toBe("PATCH");
    expect(
      JSON.parse(String(fetchMock.calls[0]!.init?.body)).content,
    ).toHaveLength(2000);

    expect(toUrl(fetchMock.calls[1]!.input)).toBe(
      "https://discord.com/api/v10/channels/channel-1/typing",
    );
    expect(fetchMock.calls[1]!.init?.headers).toEqual({
      Authorization: "Bot bot-token",
    });
  });

  it("rethrows an interaction failure when no channel id is available to fall back to", async () => {
    const fetchMock = installFetchMock();
    const actions = createDiscordChannel(
      "bot-token",
      TEST_DISCORD_PUBLIC_KEY,
      null,
      null,
    ).actions(
      createMessage({
        applicationId: "app-1",
        interactionToken: "interaction-token",
        interactionId: "interaction-1",
      }),
    );

    fetchMock.responses.push(new Response("boom", { status: 500 }));
    await expect(actions.sendText("hello")).rejects.toThrow(
      "Discord interaction API error: 500 boom",
    );
    expect(fetchMock.calls).toHaveLength(1);
  });

  it("falls back to a bot-token channel post when the interaction token has expired", async () => {
    const fetchMock = installFetchMock();
    const actions = createDiscordChannel(
      "bot-token",
      TEST_DISCORD_PUBLIC_KEY,
      null,
      null,
    ).actions(
      createMessage({
        applicationId: "app-1",
        interactionToken: "expired-token",
        interactionId: "interaction-1",
        channelId: "channel-1",
      }),
    );

    // Interaction @original edit fails (token expired), bot-token channel post succeeds.
    fetchMock.responses.push(new Response("Unknown Webhook", { status: 404 }));
    fetchMock.responses.push(jsonResponse({ id: "fallback-1" }));

    await actions.sendText("job done");

    expect(fetchMock.calls).toHaveLength(2);
    expect(toUrl(fetchMock.calls[1]!.input)).toBe(
      "https://discord.com/api/v10/channels/channel-1/messages",
    );
    expect(fetchMock.calls[1]!.init?.method).toBe("POST");
    expect(fetchMock.calls[1]!.init?.headers).toMatchObject({
      Authorization: "Bot bot-token",
    });
    expect(JSON.parse(String(fetchMock.calls[1]!.init?.body))).toMatchObject({
      content: "job done",
    });
  });

  it("surfaces a bot-token channel post failure", async () => {
    const fetchMock = installFetchMock();
    const actions = createDiscordChannel(
      "bot-token",
      TEST_DISCORD_PUBLIC_KEY,
      null,
      null,
    ).actions(
      createMessage({
        applicationId: "app-1",
        interactionToken: "expired-token",
        interactionId: "interaction-1",
        channelId: "channel-1",
      }),
    );

    fetchMock.responses.push(new Response("Unknown Webhook", { status: 404 }));
    fetchMock.responses.push(new Response("missing access", { status: 403 }));
    await expect(actions.sendText("hello")).rejects.toThrow(
      "Discord API error: 403 missing access",
    );
  });

  it("throws when a Discord typing request fails", async () => {
    const fetchMock = installFetchMock();
    const actions = createDiscordChannel(
      "bot-token",
      TEST_DISCORD_PUBLIC_KEY,
      null,
      null,
    ).actions(
      createMessage({
        applicationId: "app-1",
        interactionToken: "interaction-token",
        interactionId: "interaction-1",
        channelId: "channel-1",
      }),
    );

    fetchMock.responses.push(new Response("nope", { status: 403 }));
    await expect(actions.sendTyping()).rejects.toThrow(
      "Discord API error: 403 nope",
    );
  });

  it("skips typing without a channel id and rejects invalid source payloads", async () => {
    const fetchMock = installFetchMock();
    const adapter = createDiscordChannel(
      "bot-token",
      TEST_DISCORD_PUBLIC_KEY,
      null,
      null,
    );
    const actions = adapter.actions(
      createMessage({
        applicationId: "app-1",
        interactionToken: "interaction-token",
        interactionId: "interaction-1",
      }),
    );

    await actions.sendTyping();
    expect(fetchMock.calls).toHaveLength(0);

    expect(() =>
      adapter.actions(
        createMessage({
          applicationId: "app-1",
        }),
      ),
    ).toThrow("Invalid Discord source payload");
  });
});

describe("slack channel actions", () => {
  it("uploads documents through files.uploadV2 in one batch", async (): Promise<void> => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(
      jsonResponse({
        ok: true,
        upload_url: "https://files.slack.test/upload/1",
        file_id: "F1",
      }),
      new Response("OK"),
      jsonResponse({
        ok: true,
        upload_url: "https://files.slack.test/upload/2",
        file_id: "F2",
      }),
      new Response("OK"),
      jsonResponse({
        ok: true,
        files: [{ files: [{ id: "F1" }, { id: "F2" }] }],
      }),
    );

    const actions = createSlackChannel(
      "bot-token",
      "signing-secret",
      null,
      null,
      "white_check_mark",
    ).actions(
      createMessage({
        teamId: "T1",
        channelId: "C1",
        threadTs: "1713916800.000001",
      }),
    );

    await actions.sendFiles?.(
      [
        {
          type: "file",
          url: "https://gateway.test/media/one",
          name: "declaration.pdf",
          mimeType: "application/pdf",
          fetchData: async (): Promise<Buffer> => Buffer.from("pdf-bytes"),
        },
        {
          type: "file",
          url: "https://gateway.test/media/two",
          name: "prices.csv",
          mimeType: "text/csv",
          fetchData: async (): Promise<Buffer> => Buffer.from("a,b"),
        },
      ],
      "here you go",
    );

    // Slack ignores an outbound URL attachment, so the only way in is an
    // upload, and both files share one completeUpload call rather than posting
    // a message each.
    const urls = fetchMock.calls.map((call): string => toUrl(call.input));
    expect(
      urls.filter((url) => url.includes("getUploadURLExternal")),
    ).toHaveLength(2);
    const complete = fetchMock.calls.find((call): boolean =>
      toUrl(call.input).includes("completeUploadExternal"),
    );
    expect(complete).toBeDefined();
    const body = Object.fromEntries(
      new URLSearchParams(String(complete!.init?.body)),
    );
    expect(body.channel_id).toBe("C1");
    expect(body.thread_ts).toBe("1713916800.000001");
    expect(body.initial_comment).toBe("here you go");
    expect(
      JSON.parse(String(body.files)).map((f: { id: string }) => f.id),
    ).toEqual(["F1", "F2"]);
  });

  it("posts Slack image blocks and custom emoji stickers in the current thread", async (): Promise<void> => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(
      jsonResponse({ ok: true }),
      jsonResponse({ ok: true }),
      jsonResponse({ ok: true }),
    );

    const actions = createSlackChannel(
      "bot-token",
      "signing-secret",
      null,
      null,
      "white_check_mark",
    ).actions(
      createMessage({
        teamId: "T1",
        channelId: "C1",
        threadTs: "1713916800.000001",
      }),
    );

    await actions.sendImages?.(
      [{ type: "image", url: "https://cdn.example.com/chart.png" }],
      "A useful chart",
    );
    await actions.sendSticker?.("party_parrot");
    await actions.sendSticker?.("https://cdn.example.com/sticker.gif");

    expect(fetchMock.calls).toHaveLength(3);
    const imageBody = Object.fromEntries(
      new URLSearchParams(String(fetchMock.calls[0]!.init?.body)),
    );
    expect(imageBody).toMatchObject({
      channel: "C1",
      text: "A useful chart",
      thread_ts: "1713916800.000001",
    });
    expect(JSON.parse(imageBody.blocks!)).toEqual([
      {
        type: "section",
        text: { type: "mrkdwn", text: "A useful chart" },
      },
      {
        type: "image",
        image_url: "https://cdn.example.com/chart.png",
        alt_text: "A useful chart",
      },
    ]);
    expect(
      Object.fromEntries(
        new URLSearchParams(String(fetchMock.calls[1]!.init?.body)),
      ),
    ).toMatchObject({
      channel: "C1",
      text: ":party_parrot:",
      thread_ts: "1713916800.000001",
    });
    const stickerBody = Object.fromEntries(
      new URLSearchParams(String(fetchMock.calls[2]!.init?.body)),
    );
    expect(stickerBody).toMatchObject({
      channel: "C1",
      thread_ts: "1713916800.000001",
    });
    expect(JSON.parse(stickerBody.blocks!)).toEqual([
      {
        type: "image",
        image_url: "https://cdn.example.com/sticker.gif",
        alt_text: "Sticker",
      },
    ]);
  });

  it("posts to response_url payloads with SDK-formatted markdown", async () => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(new Response("", { status: 200 }));

    const actions = createSlackChannel(
      "bot-token",
      "signing-secret",
      null,
      null,
      "white_check_mark",
    ).actions(
      createMessage({
        teamId: "T1",
        channelId: "C1",
        responseUrl: "https://hooks.slack.test/response",
      }),
    );

    await actions.sendText("| Name | Value |\n| --- | --- |\n| Alpha | Beta |");

    expect(fetchMock.calls).toHaveLength(1);
    expect(toUrl(fetchMock.calls[0]!.input)).toBe(
      "https://hooks.slack.test/response",
    );
    expect(fetchMock.calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.calls[0]!.init?.body))).toEqual({
      text: "```\nName  | Value\n------|------\nAlpha | Beta\n```",
      response_type: "in_channel",
    });
  });

  it("keeps Slack image and sticker tools on the slash-command response URL", async (): Promise<void> => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(
      new Response("", { status: 200 }),
      new Response("", { status: 200 }),
      new Response("", { status: 200 }),
    );
    const responseUrl = "https://hooks.slack.test/response";
    const actions = createSlackChannel(
      "bot-token",
      "signing-secret",
      null,
      null,
    ).actions(
      createMessage({
        teamId: "T1",
        channelId: "C1",
        responseUrl: responseUrl,
      }),
    );

    await actions.sendImages?.(
      [{ type: "image", url: "https://cdn.example.com/chart.png" }],
      "Chart",
    );
    await actions.sendSticker?.("party_parrot");
    await actions.sendSticker?.("https://cdn.example.com/sticker.gif");

    expect(fetchMock.calls.map((call): string => toUrl(call.input))).toEqual([
      responseUrl,
      responseUrl,
      responseUrl,
    ]);
    expect(JSON.parse(String(fetchMock.calls[0]!.init?.body))).toMatchObject({
      text: "Chart",
      response_type: "in_channel",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "Chart" },
        },
        {
          type: "image",
          image_url: "https://cdn.example.com/chart.png",
          alt_text: "Chart",
        },
      ],
    });
    expect(JSON.parse(String(fetchMock.calls[1]!.init?.body))).toEqual({
      text: ":party_parrot:",
      response_type: "in_channel",
    });
    expect(JSON.parse(String(fetchMock.calls[2]!.init?.body))).toMatchObject({
      response_type: "in_channel",
      blocks: [
        {
          type: "image",
          image_url: "https://cdn.example.com/sticker.gif",
          alt_text: "Sticker",
        },
      ],
    });
  });

  it("posts threaded Slack messages and reactions through the Web API", async () => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(
      jsonResponse({ ok: true, ts: "1713916800.000003" }),
      jsonResponse({ ok: true }),
    );

    const actions = createSlackChannel(
      "bot-token",
      "signing-secret",
      null,
      null,
      "white_check_mark",
    ).actions(
      createMessage({
        teamId: "T1",
        channelId: "C1",
        threadTs: "1713916800.000001",
        messageTs: "1713916800.000002",
      }),
    );

    await actions.sendText("hello slack");
    await actions.reactToMessage(":heart:");
    await actions.sendTyping();

    expect(fetchMock.calls).toHaveLength(2);
    expect(toUrl(fetchMock.calls[0]!.input)).toBe(
      "https://slack.com/api/chat.postMessage",
    );
    expect(fetchMock.calls[0]!.init?.headers).toEqual({
      authorization: "Bearer bot-token",
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(
      Object.fromEntries(
        new URLSearchParams(String(fetchMock.calls[0]!.init?.body)),
      ),
    ).toMatchObject({
      channel: "C1",
      markdown_text: "hello slack",
      thread_ts: "1713916800.000001",
    });

    expect(toUrl(fetchMock.calls[1]!.input)).toBe(
      "https://slack.com/api/reactions.add",
    );
    expect(JSON.parse(String(fetchMock.calls[1]!.init?.body))).toEqual({
      channel: "C1",
      timestamp: "1713916800.000002",
      name: "heart",
    });
  });

  it("skips Slack reactions without a message timestamp and rejects invalid source payloads", async () => {
    const fetchMock = installFetchMock();
    const adapter = createSlackChannel(
      "bot-token",
      "signing-secret",
      null,
      null,
    );
    const actions = adapter.actions(
      createMessage({
        teamId: "T1",
        channelId: "C1",
      }),
    );

    await actions.reactToMessage();
    await actions.sendTyping();
    expect(fetchMock.calls).toHaveLength(0);

    expect(() =>
      adapter.actions(
        createMessage({
          channelId: "C1",
        }),
      ),
    ).toThrow("Invalid Slack source payload");
  });

  it("throws on Slack response_url and Web API failures", async () => {
    const fetchMock = installFetchMock();
    const adapter = createSlackChannel(
      "bot-token",
      "signing-secret",
      null,
      null,
    );

    const responseUrlActions = adapter.actions(
      createMessage({
        teamId: "T1",
        channelId: "C1",
        responseUrl: "https://hooks.slack.test/response",
      }),
    );
    fetchMock.responses.push(new Response("", { status: 500 }));
    await expect(responseUrlActions.sendText("hello")).rejects.toThrow(
      "Slack response_url failed (500)",
    );

    const apiActions = adapter.actions(
      createMessage({
        teamId: "T1",
        channelId: "C1",
        messageTs: "1713916800.000002",
      }),
    );
    fetchMock.responses.push(
      jsonResponse({ ok: false, error: "channel_not_found" }, 200),
    );
    await expect(apiActions.sendText("hello")).rejects.toThrow(
      "Slack chat.postMessage failed: channel_not_found",
    );

    fetchMock.responses.push(
      jsonResponse({ ok: false, error: "missing_scope" }, 403),
    );
    await expect(apiActions.reactToMessage()).rejects.toThrow(
      "Slack reactions.add returned HTTP 403",
    );
  });
});

describe("pancake channel actions", () => {
  it("sends inbox replies through Pancake's page message API", async () => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(jsonResponse({ success: true, id: "reply-1" }));

    const actions = createPancakeChannel(
      "page-1",
      "page-token",
      "hook-secret",
      null,
      null,
      "sender-1",
    ).actions(
      createMessage({
        pageId: "page-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        messageType: "INBOX",
      }),
    );

    await actions.sendText("hello inbox");
    await actions.sendTyping();
    await actions.reactToMessage();

    expect(fetchMock.calls).toHaveLength(1);
    expect(toUrl(fetchMock.calls[0]!.input)).toBe(
      "https://pages.fm/api/public_api/v1/pages/page-1/conversations/conversation-1/messages?page_access_token=page-token",
    );
    expect(fetchMock.calls[0]!.init?.method).toBe("POST");
    expect(fetchMock.calls[0]!.init?.headers).toEqual({
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(fetchMock.calls[0]!.init?.body))).toEqual({
      action: "reply_inbox",
      message: "hello inbox",
      sender_id: "sender-1",
    });
  });

  it("sends comment replies with the source message id", async () => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(jsonResponse({ success: true, id: "reply-1" }));

    const actions = createPancakeChannel(
      "page-1",
      "page-token",
      "hook-secret",
      null,
      null,
    ).actions(
      createMessage({
        pageId: "page-1",
        conversationId: "conversation-1",
        messageId: "comment-1",
        messageType: "COMMENT",
      }),
    );

    await actions.sendText("hello comment");

    expect(fetchMock.calls).toHaveLength(1);
    expect(JSON.parse(String(fetchMock.calls[0]!.init?.body))).toEqual({
      action: "reply_comment",
      message_id: "comment-1",
      message: "hello comment",
    });
  });

  it("throws on Pancake API failures and rejects invalid source payloads", async () => {
    const fetchMock = installFetchMock();
    const adapter = createPancakeChannel(
      "page-1",
      "page-token",
      "hook-secret",
      null,
      null,
    );
    const actions = adapter.actions(
      createMessage({
        pageId: "page-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        messageType: "INBOX",
      }),
    );

    fetchMock.responses.push(
      jsonResponse({ success: false, message: "permission denied" }, 200),
    );
    await expect(actions.sendText("hello")).rejects.toThrow(
      "Pancake send message failed (200): permission denied",
    );

    expect(() =>
      adapter.actions(
        createMessage({
          pageId: "page-1",
          conversationId: "conversation-1",
          messageId: "message-1",
          messageType: "UNKNOWN",
        }),
      ),
    ).toThrow("Invalid Pancake source payload");
  });
});

describe("zalo channel actions", () => {
  it("sends text chunks and typing through the Zalo Bot API", async () => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(
      jsonResponse({ ok: true, result: { message_id: "reply-1" } }),
      jsonResponse({ ok: true, result: { message_id: "reply-2" } }),
      jsonResponse({ ok: true, result: true }),
    );

    const actions = createZaloChannel("bot-token", "zalo-secret", {
      allowedChannelIds: null,
    }).actions(
      createMessage({
        chatId: "chat-1",
        chatType: "PRIVATE",
        messageId: "message-1",
        senderId: "user-1",
        eventName: "message.text.received",
      }),
    );

    await actions.sendText(`${"a".repeat(2000)}b`);
    await actions.sendTyping();
    await actions.reactToMessage();

    expect(fetchMock.calls).toHaveLength(3);
    expect(toUrl(fetchMock.calls[0]!.input)).toBe(
      "https://bot-api.zaloplatforms.com/botbot-token/sendMessage",
    );
    expect(fetchMock.calls[0]!.init?.method).toBe("POST");
    expect(fetchMock.calls[0]!.init?.headers).toEqual({
      "Content-Type": "application/json",
    });
    expect(fetchMock.calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(fetchMock.calls[0]!.init?.body))).toEqual({
      chat_id: "chat-1",
      text: "a".repeat(2000),
    });
    expect(JSON.parse(String(fetchMock.calls[1]!.init?.body))).toEqual({
      chat_id: "chat-1",
      text: "b",
    });
    expect(toUrl(fetchMock.calls[2]!.input)).toBe(
      "https://bot-api.zaloplatforms.com/botbot-token/sendChatAction",
    );
    expect(JSON.parse(String(fetchMock.calls[2]!.init?.body))).toEqual({
      chat_id: "chat-1",
      action: "typing",
    });
  });

  it("keeps supplementary Unicode characters intact across text chunks", async () => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(
      jsonResponse({ ok: true, result: { message_id: "reply-1" } }),
      jsonResponse({ ok: true, result: { message_id: "reply-2" } }),
    );
    const actions = createZaloChannel("bot-token", "zalo-secret").actions(
      createMessage({
        chatId: "chat-1",
        chatType: "GROUP",
        messageId: "message-1",
        senderId: "user-1",
        eventName: "message.text.received",
      }),
    );

    await actions.sendText(`${"a".repeat(1999)}😀b`);

    expect(fetchMock.calls).toHaveLength(2);
    expect(JSON.parse(String(fetchMock.calls[0]!.init?.body))).toEqual({
      chat_id: "chat-1",
      text: "a".repeat(1999),
    });
    expect(JSON.parse(String(fetchMock.calls[1]!.init?.body))).toEqual({
      chat_id: "chat-1",
      text: "😀b",
    });
  });

  it("throws on Zalo API failures and rejects invalid source payloads", async () => {
    const fetchMock = installFetchMock();
    const adapter = createZaloChannel("bot-token", "zalo-secret", {
      allowedChannelIds: null,
    });
    const actions = adapter.actions(
      createMessage({
        chatId: "chat-1",
        chatType: "PRIVATE",
        messageId: "message-1",
        senderId: "user-1",
        eventName: "message.text.received",
      }),
    );

    fetchMock.responses.push(
      jsonResponse({ ok: false, description: "permission denied" }, 200),
    );
    await expect(actions.sendText("hello")).rejects.toThrow(
      "Zalo sendMessage failed (200): permission denied",
    );

    expect(() =>
      adapter.actions(
        createMessage({
          chatId: "chat-1",
          chatType: "GROUP",
          messageId: "message-1",
          senderId: "user-1",
          eventName: "message.text.received",
        }),
      ),
    ).not.toThrow();

    expect(() =>
      adapter.actions(
        createMessage({
          chatId: "chat-1",
          chatType: "CHANNEL",
          messageId: "message-1",
          senderId: "user-1",
          eventName: "message.text.received",
        }),
      ),
    ).toThrow("Invalid Zalo source payload");
  });
});

function createMessage(source: Record<string, unknown>) {
  return {
    eventId: "event-1",
    conversationKey: "conversation-1",
    channelName: "test",
    content: [],
    source: source,
  };
}

function installFetchMock() {
  const calls: FetchCall[] = [];
  const responses: Response[] = [];

  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    calls.push({ input: input, init: init });
    const response = responses.shift();
    if (!response) {
      throw new Error(`Unexpected fetch: ${toUrl(input)}`);
    }

    return response;
  }) as unknown as typeof fetch;

  return { calls: calls, responses: responses };
}

function toUrl(input: FetchInput): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { "Content-Type": "application/json" },
  });
}

// sendMediaGroup answers with one message per album entry, unlike the single
// message every other send returns.
function telegramMediaGroupResponse(count: number) {
  return jsonResponse({
    ok: true,
    result: Array.from({ length: count }, (_unused, index) => ({
      message_id: 100 + index,
      chat: { id: 123, type: "private" },
      date: 1_700_000_000,
    })),
  });
}

interface TelegramMediaGroupItem {
  caption?: string;
  media: string;
  type: string;
}

// sendMediaGroup goes out as multipart with the album described in a `media`
// JSON field, so the assertions read that rather than the request body.
function telegramMediaGroup(body: RequestInit["body"]): {
  media: TelegramMediaGroupItem[];
} {
  if (!(body instanceof FormData)) {
    throw new Error("Expected sendMediaGroup to post FormData");
  }

  return { media: JSON.parse(String(body.get("media"))) };
}

function telegramMessageResponse(messageId: number, text: string) {
  return jsonResponse({
    ok: true,
    result: {
      message_id: messageId,
      chat: { id: 123, type: "private" },
      date: 1_700_000_000,
      text: text,
    },
  });
}
