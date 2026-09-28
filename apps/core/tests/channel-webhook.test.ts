/** Channel adapters ignore webhook bodies that are not a JSON object and keep every real payload. */

import { describe, expect, it } from "bun:test";
import {
  parseChannelWebhookBody,
  type ChannelAdapter,
  type ChannelRequest,
} from "../src/shared/channels.ts";
import { createDiscordChannel } from "../src/shared/discord-channel.ts";
import { createGitHubChannel } from "../src/shared/github-channel.ts";
import { createMatrixChannel } from "../src/shared/matrix-channel.ts";
import { createPancakeChannel } from "../src/shared/pancake-channel.ts";
import { createSlackChannel } from "../src/shared/slack-channel.ts";
import { createTelegramChannel } from "../src/shared/telegram-channel.ts";
import { createZaloChannel } from "../src/shared/zalo-channel.ts";

const INVALID_PAYLOAD: { kind: "ignore"; reason: "invalid_payload" } = {
  kind: "ignore",
  reason: "invalid_payload",
};

const github = createGitHubChannel("secret", "app", "key", null, null);
const pancake = createPancakeChannel("page-1", "token", "secret", null, null);
const zalo = createZaloChannel("token", "secret");
const adapters: ChannelAdapter[] = [
  createDiscordChannel("token", "a".repeat(64), null, null),
  github,
  createMatrixChannel({
    accessToken: "secret",
    apiUrl: "https://matrix.test",
    forwarderUrl: "https://forwarder.test",
    allowedChannelIds: null,
    allowedUserIds: null,
  }),
  pancake,
  createSlackChannel("token", "secret", null, null),
  createTelegramChannel("token", "secret", null, null, "👀"),
  zalo,
];

describe("parseChannelWebhookBody", (): void => {
  it("returns the object as sent, nulls and unknown keys included", (): void => {
    expect(
      parseChannelWebhookBody<{ a: null; extra: number }>(
        "test",
        '{"a":null,"extra":1}',
      ),
    ).toEqual({ kind: "payload", payload: { a: null, extra: 1 } });
  });

  it("ignores malformed JSON", (): void => {
    expect(parseChannelWebhookBody("test", "{")).toEqual(INVALID_PAYLOAD);
  });

  it("ignores JSON that is not an object", (): void => {
    for (const body of ["null", "[]", '"text"', "1", "true"]) {
      expect(parseChannelWebhookBody("test", body)).toEqual(INVALID_PAYLOAD);
    }
  });
});

for (const adapter of adapters) {
  it(`${adapter.name} ignores a non-object body`, async (): Promise<void> => {
    expect(await adapter.parse(request("[]"))).toEqual(INVALID_PAYLOAD);
  });
}

describe("provider payloads with null fields", (): void => {
  it("accepts a Pancake message with null fields", async (): Promise<void> => {
    const parsed = await pancake.parse(
      request(
        JSON.stringify({
          page_id: "page-1",
          event_type: "messaging",
          data: {
            conversation: {
              id: "conversation-1",
              type: "INBOX",
              tags: null,
              from: { id: "customer-1", name: "Ada" },
            },
            message: {
              id: "message-1",
              conversation_id: "conversation-1",
              message: null,
              original_message: null,
              type: "INBOX",
              attachments: [
                { id: 7, type: "photo", url: null },
                { type: "photo", url: "https://pancake.test/a.jpg" },
              ],
              from: {
                id: "customer-1",
                name: "Ada",
                page_customer_id: "page-customer-1",
              },
            },
          },
        }),
      ),
    );

    expect(parsed.kind).toBe("message");
  });

  it("accepts a Zalo photo with a null caption", async (): Promise<void> => {
    const parsed = await zalo.parse(
      request(
        JSON.stringify({
          event_name: "message.image.received",
          message: {
            message_id: "message-1",
            photo: "https://zalo.test/photo.jpg",
            caption: null,
            chat: { id: "chat-1", chat_type: "PRIVATE" },
            from: { id: "user-1", is_bot: false },
          },
        }),
      ),
    );

    expect(parsed.kind).toBe("message");
  });

  it("accepts a GitHub comment with a null user", async (): Promise<void> => {
    const parsed = await github.parse(
      request(
        JSON.stringify({
          action: "created",
          repository: {
            full_name: "owner/repo",
            name: "repo",
            owner: { login: "owner" },
          },
          issue: { number: 12 },
          comment: { id: 55, body: "Looks good", user: null },
          installation: { id: 99 },
          sender: { login: "alice", type: "User" },
        }),
        { "x-github-event": "issue_comment", "x-github-delivery": "d-1" },
      ),
    );

    expect(parsed.kind).toBe("message");
  });
});

function request(
  body: string,
  headers: Record<string, string> = { "content-type": "application/json" },
): ChannelRequest {
  return {
    method: "POST",
    rawPath: "/webhook",
    rawQueryString: "",
    headers: headers,
    body: body,
  };
}
