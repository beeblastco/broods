/**
 * Telegram ask_questions rendering and button intake.
 * Cover the inline keyboard a prompt goes out with and how a click on one of
 * its buttons comes back as an answer rather than a chat message.
 */

import { describe, expect, it } from "bun:test";
import type { ChannelRequest } from "../src/shared/channels.ts";
import { createTelegramChannel } from "../src/shared/telegram-channel.ts";

const STATUS_ID = "async_tool_2f1c9a9e-8d2f-4a7b-9c3d-0e1f2a3b4c5d";
const WEBHOOK_SECRET = "secret";

interface TelegramApiCall {
  url: string;
  body: unknown;
}

const adapter = createTelegramChannel(
  "bot-token",
  WEBHOOK_SECRET,
  null,
  null,
  "👀",
);

describe("telegram ask_questions", () => {
  it("posts one button per option carrying the statusId and positions", async () => {
    const actions = adapter.actions({
      eventId: "telegram:1",
      conversationKey: "tg:123",
      channelName: "telegram",
      content: "hi",
      source: { chatId: 123, messageId: "5", threadId: "123" },
    });

    const calls = await withTelegramApi(() =>
      actions.sendQuestions!({
        statusId: STATUS_ID,
        text: "Which stage?\n1. dev\n2. prod",
        questions: [
          {
            id: "deploy_target",
            header: "Target",
            question: "Which stage?",
            options: [{ label: "dev" }, { label: "prod" }],
          },
        ],
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/sendMessage");
    expect(calls[0]!.body).toMatchObject({
      chat_id: 123,
      text: "Which stage?\n1. dev\n2. prod",
      reply_markup: {
        inline_keyboard: [
          [{ text: "dev", callback_data: `q:${STATUS_ID}:0:0` }],
          [{ text: "prod", callback_data: `q:${STATUS_ID}:0:1` }],
        ],
      },
    });
  });

  it("turns a button click into an answer, acknowledges it and clears the keyboard", async () => {
    let parsed: Awaited<ReturnType<typeof adapter.parse>> | undefined;
    const calls = await withTelegramApi(async (): Promise<void> => {
      parsed = await adapter.parse(
        telegramRequest({
          update_id: 42,
          callback_query: {
            id: "cb-1",
            chat_instance: "ci",
            data: `q:${STATUS_ID}:0:1`,
            from: {
              id: 999,
              is_bot: false,
              first_name: "Ann",
              username: "ann",
            },
            message: {
              message_id: 10,
              date: 0,
              chat: { id: 123, type: "private" },
              from: { id: 1, is_bot: true, first_name: "bot" },
              text: "Which stage?",
            },
          },
        }),
      );
    });

    expect(parsed?.kind).toBe("message");
    if (parsed?.kind !== "message") throw new Error("expected a message");
    expect(parsed.message.conversationKey).toBe("tg:123");
    expect(parsed.message.answer).toEqual({
      statusId: STATUS_ID,
      questionIndex: 0,
      optionIndex: 1,
    });
    expect(parsed.message.identity).toMatchObject({
      channelId: "123",
      userId: "999",
      userName: "ann",
    });
    expect(parsed.message.source).toMatchObject({
      chatId: 123,
      fromUserId: 999,
    });
    expect(calls.map((call) => call.url.split("/").at(-1))).toEqual([
      "answerCallbackQuery",
      "editMessageReplyMarkup",
    ]);
  });

  it("acknowledges and drops a callback that is not one of ours", async () => {
    let parsed: Awaited<ReturnType<typeof adapter.parse>> | undefined;
    const calls = await withTelegramApi(async (): Promise<void> => {
      parsed = await adapter.parse(
        telegramRequest({
          update_id: 43,
          callback_query: {
            id: "cb-2",
            chat_instance: "ci",
            data: "something-else",
            from: { id: 999, is_bot: false, first_name: "Ann" },
          },
        }),
      );
    });

    expect(parsed?.kind).toBe("ignore");
    expect(calls.map((call) => call.url.split("/").at(-1))).toEqual([
      "answerCallbackQuery",
    ]);
  });
});

function telegramRequest(update: unknown): ChannelRequest {
  return {
    method: "POST",
    rawPath: "/webhooks/acct/telegram",
    rawQueryString: "",
    headers: { "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
    body: JSON.stringify(update),
  };
}

// Captures every Bot API call made while `run` executes, including the
// fire-and-forget acknowledgements, which a timer tick lets land.
async function withTelegramApi(
  run: () => Promise<void>,
): Promise<TelegramApiCall[]> {
  const calls: TelegramApiCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as unknown,
    });

    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
    });
  }) as typeof globalThis.fetch;
  try {
    await run();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    globalThis.fetch = originalFetch;
  }

  return calls;
}
