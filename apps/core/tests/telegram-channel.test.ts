/**
 * Telegram channel adapter tests.
 * Cover webhook auth, allow-list filtering, mention gating, and inbound message
 * normalization here.
 */

import { describe, expect, it } from "bun:test";
import type { InboundMessage } from "../src/shared/channels.ts";
import { createTelegramChannel } from "../src/shared/telegram-channel.ts";

const GROUP_CHAT = { id: 123, type: "supergroup" };

describe("telegram channel adapter", () => {
  it("authenticates matching webhook secrets and rejects mismatches", () => {
    const adapter = createTelegramChannel(
      "bot-token",
      "secret",
      new Set(["123"]),
      null,
      "👀",
    );

    expect(
      adapter.authenticate(
        createRequest(
          {
            update_id: 1,
            message: createMessage({ text: "hello" }),
          },
          {
            "x-telegram-bot-api-secret-token": "secret",
          },
        ),
      ),
    ).toBe(true);

    expect(
      adapter.authenticate(
        createRequest(
          {
            update_id: 1,
            message: createMessage({ text: "hello" }),
          },
          {
            "x-telegram-bot-api-secret-token": "wrong",
          },
        ),
      ),
    ).toBe(false);
  });

  it("ignores updates without text content", async () => {
    const adapter = createTelegramChannel(
      "bot-token",
      "secret",
      new Set(["123"]),
      null,
      "👀",
    );

    expect(
      await adapter.parse(
        createRequest({
          update_id: 1,
          message: createMessage({ text: undefined }),
        }),
      ),
    ).toEqual({ kind: "ignore" });
  });

  it("ignores chats outside the allow list", async () => {
    const adapter = createTelegramChannel(
      "bot-token",
      "secret",
      new Set(["999"]),
      null,
      "👀",
    );

    expect(
      await adapter.parse(
        createRequest({
          update_id: 1,
          message: createMessage({ text: "hello" }),
        }),
      ),
    ).toEqual({ kind: "ignore" });
  });

  it("answers an undeclared chat under the wildcard, still gated by sender", async () => {
    const open = createTelegramChannel(
      "bot-token",
      "secret",
      new Set(["*"]),
      null,
      "👀",
    );

    expect(
      (
        await open.parse(
          createRequest({
            update_id: 1,
            message: createMessage({ text: "hello" }),
          }),
        )
      ).kind,
    ).toBe("message");

    const strangers = createTelegramChannel(
      "bot-token",
      "secret",
      new Set(["*"]),
      new Set(["8"]),
      "👀",
    );

    expect(
      await strangers.parse(
        createRequest({
          update_id: 1,
          message: createMessage({ text: "hello" }),
        }),
      ),
    ).toEqual({ kind: "ignore" });
  });

  it("normalizes inbound messages from the main message payload", async () => {
    const adapter = createTelegramChannel(
      "bot-token",
      "secret",
      new Set(["123"]),
      null,
      "👀",
    );

    const parsed = await adapter.parse(
      createRequest({
        update_id: 7,
        message: createMessage({ text: "hello", message_id: 42 }),
      }),
    );

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected Telegram message to be accepted");
    }

    expect(parsed.message.eventId).toBe("tg:7");
    expect(parsed.message.conversationKey).toBe("tg:123");
    expect(parsed.message.channelName).toBe("telegram");
    expect(parsed.message.content).toBe("hello");
    expect(parsed.message.source).toEqual({
      chatId: 123,
      messageId: "123:42",
      threadId: "telegram:123",
      fromUserId: 7,
      fromUsername: "alice",
    });
  });

  it("uses edited_message when no main message is present", async () => {
    const adapter = createTelegramChannel(
      "bot-token",
      "secret",
      new Set(["123"]),
      null,
      "👀",
    );

    const parsed = await adapter.parse(
      createRequest({
        update_id: 8,
        edited_message: createMessage({ text: "edited", message_id: 99 }),
      }),
    );

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected Telegram edited message to be accepted");
    }

    expect(parsed.message.eventId).toBe("tg:8");
    expect(parsed.message.content).toBe("edited");
    expect(parsed.message.source).toEqual({
      chatId: 123,
      messageId: "123:99",
      threadId: "telegram:123",
      fromUserId: 7,
      fromUsername: "alice",
    });
  });

  it("stores untagged group chatter as context once botUsername is set", async () => {
    const adapter = createGatedAdapter();

    const parsed = await adapter.parse(
      createRequest({
        update_id: 10,
        message: createMessage({
          text: "send the template to the other team",
          chat: GROUP_CHAT,
        }),
      }),
    );

    expect(parsed.kind).toBe("context");
  });

  it("keeps answering every group message when botUsername is unset", async () => {
    const adapter = createTelegramChannel(
      "bot-token",
      "secret",
      new Set(["123"]),
      null,
      "👀",
    );

    const parsed = await adapter.parse(
      createRequest({
        update_id: 11,
        message: createMessage({ text: "hello team", chat: GROUP_CHAT }),
      }),
    );

    expect(parsed.kind).toBe("message");
  });

  it("runs the agent when a group message mentions it", async () => {
    const adapter = createGatedAdapter();
    const text = "@tracy_bot what is the one-off price";

    const parsed = await adapter.parse(
      createRequest({
        update_id: 12,
        message: createMessage({
          text: text,
          chat: GROUP_CHAT,
          entities: entityFor(text, "@tracy_bot", "mention"),
        }),
      }),
    );

    expect(parsed.kind).toBe("message");
  });

  it("matches the mention whatever the case, with or without a leading @", async () => {
    const adapter = createGatedAdapter("@Tracy_Bot");
    const text = "hey @TRACY_BOT";

    const parsed = await adapter.parse(
      createRequest({
        update_id: 13,
        message: createMessage({
          text: text,
          chat: GROUP_CHAT,
          entities: entityFor(text, "@TRACY_BOT", "mention"),
        }),
      }),
    );

    expect(parsed.kind).toBe("message");
  });

  it("answers a reply to its own message, but not a reply to someone else", async () => {
    const adapter = createGatedAdapter();

    const toBot = await adapter.parse(
      createRequest({
        update_id: 14,
        message: createMessage({
          text: "and with margin?",
          chat: GROUP_CHAT,
          reply_to_message: createMessage({
            text: "here is the template",
            chat: GROUP_CHAT,
            from: {
              id: 99,
              first_name: "Tracy",
              username: "tracy_bot",
              is_bot: true,
            },
          }),
        }),
      }),
    );
    expect(toBot.kind).toBe("message");

    const toPerson = await adapter.parse(
      createRequest({
        update_id: 15,
        message: createMessage({
          text: "and with margin?",
          chat: GROUP_CHAT,
          reply_to_message: createMessage({
            text: "here is the template",
            chat: GROUP_CHAT,
          }),
        }),
      }),
    );
    expect(toPerson.kind).toBe("context");
  });

  it("quotes the message a reply answers, and leaves a plain message alone", async () => {
    const adapter = createGatedAdapter();

    const reply = await adapter.parse(
      createRequest({
        update_id: 21,
        message: createMessage({
          text: "and with margin?",
          chat: GROUP_CHAT,
          reply_to_message: createMessage({
            text: "here is the template",
            chat: GROUP_CHAT,
            from: {
              id: 99,
              first_name: "Tracy",
              username: "tracy_bot",
              is_bot: true,
            },
          }),
        }),
      }),
    );

    if (reply.kind !== "message") {
      throw new Error("Expected a reply to the bot to be accepted");
    }
    expect(reply.message.content).toBe(
      "> Tracy: here is the template\nand with margin?",
    );

    const plain = await adapter.parse(
      createRequest({
        update_id: 22,
        message: createMessage({ text: "hello" }),
      }),
    );

    if (plain.kind !== "message") {
      throw new Error("Expected a private message to be accepted");
    }
    expect(plain.message.content).toBe("hello");
  });

  it("truncates a long quote instead of replaying the whole message", async () => {
    const adapter = createGatedAdapter();
    const long = "x".repeat(600);

    const parsed = await adapter.parse(
      createRequest({
        update_id: 23,
        message: createMessage({
          text: "and with margin?",
          chat: GROUP_CHAT,
          reply_to_message: createMessage({
            text: long,
            chat: GROUP_CHAT,
            from: {
              id: 99,
              first_name: "Tracy",
              username: "tracy_bot",
              is_bot: true,
            },
          }),
        }),
      }),
    );

    if (parsed.kind !== "message") {
      throw new Error("Expected a reply to the bot to be accepted");
    }
    expect(parsed.message.content).toBe(
      `> Tracy: ${"x".repeat(500)}...\nand with margin?`,
    );
  });

  it("answers a bare slash command and one aimed at it, not one aimed elsewhere", async () => {
    const adapter = createGatedAdapter();

    const bare = await adapter.parse(
      createRequest({
        update_id: 16,
        message: createMessage({
          text: "/new",
          chat: GROUP_CHAT,
          entities: entityFor("/new", "/new", "bot_command"),
        }),
      }),
    );
    expect(bare.kind).toBe("message");

    const mine = await adapter.parse(
      createRequest({
        update_id: 17,
        message: createMessage({
          text: "/new@tracy_bot",
          chat: GROUP_CHAT,
          entities: entityFor(
            "/new@tracy_bot",
            "/new@tracy_bot",
            "bot_command",
          ),
        }),
      }),
    );
    expect(mine.kind).toBe("message");

    const other = await adapter.parse(
      createRequest({
        update_id: 18,
        message: createMessage({
          text: "/new@steve_bot",
          chat: GROUP_CHAT,
          entities: entityFor(
            "/new@steve_bot",
            "/new@steve_bot",
            "bot_command",
          ),
        }),
      }),
    );
    expect(other.kind).toBe("context");
  });

  it("answers a private chat with no tag at all", async () => {
    const adapter = createGatedAdapter();

    const parsed = await adapter.parse(
      createRequest({
        update_id: 19,
        message: createMessage({ text: "hello" }),
      }),
    );

    expect(parsed.kind).toBe("message");
  });

  it("never runs for another bot, even when that bot tags it", async () => {
    const adapter = createGatedAdapter();
    const text = "@tracy_bot take this";

    const parsed = await adapter.parse(
      createRequest({
        update_id: 20,
        message: createMessage({
          text: text,
          chat: GROUP_CHAT,
          entities: entityFor(text, "@tracy_bot", "mention"),
          from: {
            id: 55,
            first_name: "Steve",
            username: "beeblast_steve",
            is_bot: true,
          },
        }),
      }),
    );

    expect(parsed.kind).toBe("context");
  });

  it("accepts a photo with no caption and carries it as an attachment", async () => {
    const parsed = await parseTelegram({
      update_id: 30,
      message: {
        ...createMessage({}),
        photo: [
          { file_id: "small", file_unique_id: "u1", width: 90, height: 90 },
          { file_id: "large", file_unique_id: "u2", width: 1280, height: 1280 },
        ],
      },
    });

    // A captionless photo used to be dropped for having no text.
    expect(parsed.content).toBe("");
    // Telegram offers a photo at several sizes; the largest is the one to read.
    expect(parsed.attachments?.[0]).toMatchObject({
      type: "image",
      mimeType: "image/jpeg",
      fetchMetadata: { fileId: "large" },
    });
  });

  it("reads a caption as the message text and keeps the document beside it", async () => {
    const parsed = await parseTelegram({
      update_id: 31,
      message: {
        ...createMessage({}),
        caption: "the quarterly numbers",
        document: {
          file_id: "doc-1",
          file_name: "q3.pdf",
          mime_type: "application/pdf",
          file_size: 1024,
        },
      },
    });

    expect(parsed.content).toBe("the quarterly numbers");
    expect(parsed.attachments).toEqual([
      expect.objectContaining({
        type: "file",
        name: "q3.pdf",
        mimeType: "application/pdf",
        size: 1024,
      }),
    ]);
  });

  it("answers a caption that @-mentions the bot", async () => {
    const caption = "@tracy_bot what is this?";
    const parsed = await createGatedAdapter().parse(
      createRequest({
        update_id: 32,
        message: {
          ...createMessage({ chat: GROUP_CHAT }),
          caption: caption,
          // A caption's mentions are indexed against caption_entities, so a
          // gate reading `entities` never sees them.
          caption_entities: entityFor(caption, "@tracy_bot", "mention"),
          photo: [{ file_id: "p1", file_unique_id: "u1", width: 8, height: 8 }],
        },
      }),
    );

    expect(parsed.kind).toBe("message");
  });

  it("reads a static sticker the Chat SDK does not model, and skips an animated one", async () => {
    const parsed = await parseTelegram({
      update_id: 33,
      message: {
        ...createMessage({}),
        sticker: { file_id: "st-1", file_unique_id: "u1", emoji: "🎉" },
      },
    });

    expect(parsed.attachments).toEqual([
      expect.objectContaining({
        type: "image",
        name: "sticker-🎉.webp",
        mimeType: "image/webp",
      }),
    ]);

    // A .tgs or .webm sticker is not a picture any model can read, and the
    // emoji says more than a failed download would.
    const animated = await parseTelegram({
      update_id: 34,
      message: {
        ...createMessage({ text: "nice" }),
        sticker: { file_id: "st-2", file_unique_id: "u2", is_animated: true },
      },
    });
    expect(animated.attachments).toBeUndefined();
  });

  it("carries the emoji as the text of a caption-less animated sticker", async () => {
    // With no attachment and no caption, the emoji is all the message has —
    // without it the turn would arrive entirely empty.
    const parsed = await parseTelegram({
      update_id: 36,
      message: {
        ...createMessage({}),
        sticker: {
          file_id: "st-3",
          file_unique_id: "u3",
          emoji: "😅",
          is_video: true,
        },
      },
    });

    expect(parsed.content).toBe("😅");
    expect(parsed.attachments).toBeUndefined();
  });

  it("still ignores a message carrying neither text nor media", async () => {
    const adapter = createTelegramChannel(
      "bot-token",
      "secret",
      null,
      null,
      "👀",
    );

    expect(
      (
        await adapter.parse(
          createRequest({ update_id: 35, message: createMessage({}) }),
        )
      ).kind,
    ).toBe("ignore");
  });
});

// The normalized message a Telegram update produces, or a thrown error naming
// why the update was refused.
async function parseTelegram(
  payload: Record<string, unknown>,
): Promise<InboundMessage> {
  const adapter = createTelegramChannel(
    "bot-token",
    "secret",
    null,
    null,
    "👀",
  );
  const parsed = await adapter.parse(createRequest(payload));
  if (parsed.kind !== "message") {
    throw new Error(
      `Expected an accepted Telegram message, got ${parsed.kind}`,
    );
  }

  return parsed.message;
}

function createGatedAdapter(botUsername: string = "tracy_bot") {
  return createTelegramChannel(
    "bot-token",
    "secret",
    new Set(["123"]),
    null,
    "👀",
    undefined,
    { botUsername: botUsername },
  );
}

// Telegram tags each `@name` and `/command` in the text with an entity, and the
// mention gate reads those rather than searching the text.
function entityFor(text: string, token: string, type: string) {
  return [{ type: type, offset: text.indexOf(token), length: token.length }];
}

function createRequest(
  payload: Record<string, unknown>,
  headers: Record<string, string> = {
    "x-telegram-bot-api-secret-token": "secret",
  },
) {
  return {
    method: "POST",
    rawPath: "/",
    rawQueryString: "",
    headers: headers,
    body: JSON.stringify(payload),
  };
}

function createMessage(
  overrides: Partial<{
    message_id: number;
    text: string | undefined;
    chat: { id: number; type: string };
    entities: Array<{ type: string; offset: number; length: number }>;
    from: {
      id: number;
      first_name: string;
      username?: string;
      is_bot: boolean;
    };
    reply_to_message: Record<string, unknown>;
  }> = {},
) {
  return {
    message_id: overrides.message_id ?? 42,
    from: overrides.from ?? {
      id: 7,
      first_name: "Alice",
      username: "alice",
      is_bot: false,
    },
    chat: overrides.chat ?? {
      id: 123,
      type: "private",
    },
    date: 1_700_000_000,
    ...(overrides.text !== undefined ? { text: overrides.text } : {}),
    ...(overrides.entities ? { entities: overrides.entities } : {}),
    ...(overrides.reply_to_message
      ? { reply_to_message: overrides.reply_to_message }
      : {}),
  };
}
