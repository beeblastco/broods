import { expect, test } from "bun:test";
import type { ChannelParseResult } from "../../../../apps/core/src/shared/channels.ts";
import { createTelegramChannel } from "../../../../apps/core/src/shared/telegram-channel.ts";

const CHAT = { id: 123, type: "supergroup" };
const SENDER = { id: 7, first_name: "Alice", username: "alice", is_bot: false };

const ADAPTER = createTelegramChannel(
  "bot-token",
  "secret",
  new Set(["123"]),
  null,
  "👀",
  undefined,
  { botUsername: "Support_Bot" },
);

async function update(
  id: number,
  date: number,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<ChannelParseResult> {
  return await ADAPTER.parse({
    method: "POST",
    rawPath: "/v1/runs",
    rawQueryString: "",
    headers: { "x-telegram-bot-api-secret-token": "secret" },
    body: JSON.stringify({
      update_id: id,
      message: {
        message_id: id,
        from: SENDER,
        chat: CHAT,
        date: date,
        text: text,
        ...extra,
      },
    }),
  });
}

test("one adapter caches the messages it parses, in send order, across redeliveries", async (): Promise<void> => {
  const results: ChannelParseResult[] = [
    await update(11, 1_700_000_100, "later"),
    await update(10, 1_700_000_000, "earlier"),
    await update(11, 1_700_000_100, "later"),
    await update(12, 1_700_000_100, "@support_bot same second", {
      entities: [{ type: "mention", offset: 0, length: 12 }],
    }),
    await update(13, 1_700_000_200, "reply", {
      reply_to_message: {
        message_id: 10,
        from: SENDER,
        chat: CHAT,
        date: 1_700_000_000,
        text: "earlier",
      },
    }),
  ];

  expect(results.map((result) => result.kind)).toEqual([
    "context",
    "context",
    "context",
    "message",
    "context",
  ]);
  expect(
    results.map((result) =>
      result.kind === "ignore" ? "" : result.message.eventId,
    ),
  ).toEqual(["tg:11", "tg:10", "tg:11", "tg:12", "tg:13"]);
});
