/** Webhook boundaries reject malformed input before side effects or field access. */

import type { TelegramUpdate } from "@chat-adapter/telegram";
import { describe, expect, it } from "bun:test";
import {
  githubWebhook,
  parseChannelWebhook,
  telegramWebhook,
} from "../src/shared/channel-webhook.ts";
import { createGitHubChannel } from "../src/shared/github-channel.ts";
import { createMatrixChannel } from "../src/shared/matrix-channel.ts";
import { createPancakeChannel } from "../src/shared/pancake-channel.ts";
import { createTelegramChannel } from "../src/shared/telegram-channel.ts";
import { createZaloChannel } from "../src/shared/zalo-channel.ts";
import type { ChannelAdapter } from "../src/shared/channels.ts";

const adapters: ChannelAdapter[] = [
  createGitHubChannel("secret", "app", "key", null, null),
  createMatrixChannel({
    accessToken: "secret",
    apiUrl: "https://matrix.test",
    forwarderUrl: "https://forwarder.test",
    allowedChannelIds: null,
    allowedUserIds: null,
  }),
  createPancakeChannel("page", "token", "secret", null, null),
  createTelegramChannel("token", "secret", null, null, "👀"),
  createZaloChannel("token", "secret"),
];
const invalidFields: Record<string, unknown> = {
  github: { repository: { full_name: 42 } },
  matrix: {
    type: "MATRIX_ROOM_EVENT",
    event: { type: "m.room.message", content: null },
  },
  pancake: { data: { message: { message: { text: "hi" } } } },
  telegram: { update_id: 1, callback_query: { id: "click", from: null } },
  zalo: { event_name: "message.text.received", message: { text: ["hi"] } },
};

for (const adapter of adapters) {
  describe(`${adapter.name} webhook input`, (): void => {
    for (const body of ["{", "null", "[]", '"text"', "1", "true"]) {
      it(`ignores invalid JSON object ${body}`, async (): Promise<void> => {
        expect(
          await adapter.parse({
            method: "POST",
            rawPath: "/webhook",
            rawQueryString: "",
            headers: {},
            body: body,
          }),
        ).toEqual({ kind: "ignore", reason: "invalid_payload" });
      });
    }
    it("rejects invalid nested fields", async (): Promise<void> => {
      expect(
        await adapter.parse({
          method: "POST",
          rawPath: "/webhook",
          rawQueryString: "",
          headers: {},
          body: JSON.stringify(invalidFields[adapter.name]),
        }),
      ).toEqual({ kind: "ignore", reason: "invalid_payload" });
    });
  });
}

it("strips unrecognized and prototype keys before using GitHub fields", (): void => {
  const parsed = parseChannelWebhook(
    '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"repository":{"name":"repo","__proto__":{"polluted":true}}}',
    githubWebhook,
  );

  expect(parsed).toEqual({ repository: { name: "repo" } });
  expect(Object.hasOwn(parsed!, "__proto__")).toBe(false);
  expect(Object.hasOwn(parsed!, "constructor")).toBe(false);
});

it("preserves nested Telegram rich text and animated sticker flags", (): void => {
  const sticker = { file_id: "sticker", is_animated: true, is_video: false };
  const update: TelegramUpdate = {
    update_id: 1,
    message: {
      message_id: 2,
      date: 3,
      chat: { id: 4, type: "private" },
      rich_message: {
        blocks: [
          {
            type: "blockquote",
            blocks: [
              { type: "paragraph", text: { type: "bold", text: "hello" } },
            ],
          },
        ],
      },
      sticker: sticker,
    },
  };

  expect(parseChannelWebhook(JSON.stringify(update), telegramWebhook)).toEqual(
    update,
  );
});
