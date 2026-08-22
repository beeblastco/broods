/**
 * Telegram channel adapter tests.
 * Cover webhook auth, allow-list filtering, mention gating, and inbound message
 * normalization here.
 */

import { describe, expect, it } from "bun:test";
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
});

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
